import { BaseRoute, Get, Post, ServerStarted, Server, Request, Response } from 'realm-object-server'
import { graphqlExpress, ExpressHandler, graphiqlExpress } from 'apollo-server-express';
import { DocumentNode, GraphQLError, GraphQLSchema, GraphQLObjectType, buildSchema } from 'graphql';
import { ObjectSchemaProperty, ObjectSchema, Results } from 'realm';
import { makeExecutableSchema } from 'graphql-tools';
import { IResolverObject, IResolvers } from 'graphql-tools/dist/Interfaces';
import * as pluralize from 'pluralize'

interface SchemaTypes {
    type: string;
    inputType: string;
}

interface PKInfo { 
    name: string;
    type: string;
}

interface PropertySchemaInfo {
    propertySchema: string;
    inputPropertySchema: string;
    pk: PKInfo;
}

@BaseRoute('/graphql')
export class GraphQLService {
    server: Server;
    handler: ExpressHandler;
    graphiql: ExpressHandler;
    
    @ServerStarted()
    serverStarted(server: Server) {
        this.server = server;

        this.handler = graphqlExpress(async (req, res) => {
            let path = req.params['path'];
            let realm = await this.server.openRealm(path)

            return {
                schema: this.getSchema(path, realm)
            };
        });

        this.graphiql = graphiqlExpress(req => {
            let path = req.params['path'];
            
            return {
                endpointURL: `/graphql/${path}`
            };
        });
    }

    @Get('/explore/:path')
    getExplore(@Request() req, @Response() res) {
        this.graphiql(req, res, null);
    }

    @Post('/explore/:path')
    postExplore(@Request() req, @Response() res) {
        this.graphiql(req, res, null);
    }

    @Get('/:path')
    get(@Request() req, @Response() res) {
        this.handler(req, res, null);
    }

    @Post('/:path')
    post(@Request() req, @Response() res) {
        this.handler(req, res, null);
    }

    getSchema(path: string, realm: Realm) : GraphQLSchema {
        let schema = '';
        let types = new Array<[string, PKInfo]>();
        let queryResolver: IResolverObject = { };
        let mutationResolver: IResolverObject = { };
        
        for (const obj of realm.schema) {
            let propertyInfo = this.getPropertySchema(obj);

            types.push([obj.name, propertyInfo.pk]);
          
            schema += `type ${obj.name} { \n${propertyInfo.propertySchema}}\n\n`;
            schema += `input ${obj.name}Input { \n${propertyInfo.inputPropertySchema}}\n\n`;
        }

        let query = 'type Query {\n';
        let mutation = 'type Mutation {\n';
        
        for (const [type, pk] of types) {
            const camelCasedType = this.camelcase(type);
            const pluralType = pluralize(camelCasedType);

            query += this.setupGetAllObjects(queryResolver, type, pluralType, realm);
            mutation += this.setupAddObject(mutationResolver, type, realm);

            // If object has PK, we add get by PK and update option.
            if (pk) {
                query += this.setupGetObjectByPK(queryResolver, type, camelCasedType, realm, pk);
                mutation += this.setupUpdateObject(mutationResolver, type, realm);
                mutation += this.setupDeleteObject(mutationResolver, type, realm, pk);
            }
        }

        query += '}\n\n';
        mutation += '}';

        schema += query;
        schema += mutation;

        return makeExecutableSchema({ 
            typeDefs: schema,
            resolvers: {
                Query: queryResolver,
                Mutation: mutationResolver
            },
        });
    }

    private setupGetAllObjects(queryResolver: IResolverObject, type: string, pluralType: string, realm: Realm): string {
        queryResolver[pluralType] = (_, args) => {
            let result: any = realm.objects(type);
            if (args.query) {
                result = result.filtered(args.query);
            }

            if (args.sortBy) {
                let descending = args.descending || false;
                result = result.sorted(args.sortBy, descending);
            }

            if (args.skip || args.take) {
                let skip = args.skip || 0;
                if (args.take) {
                    result = result.slice(skip, args.take + skip);
                }
                else {
                    result = result.slice(skip);
                }
            }
            
            return result;
        };

        // TODO: limit sortBy to only valid properties
        return `${pluralType}(query: String, sortBy: String, descending: Boolean, skip: Int, take: Int): [${type}!]\n`;
    }

    private setupAddObject(mutationResolver: IResolverObject, type: string, realm: Realm): string {
        mutationResolver[`add${type}`] = (_, args) => {
            let result: any;
            realm.write(() => {
                result = realm.create(type, args.input);
            });

            return result;
        };

        return `add${type}(input: ${type}Input): ${type}\n`;
    }

    private setupGetObjectByPK(queryResolver: IResolverObject, type: string, camelCasedType: string, realm: Realm, pk: PKInfo): string {
        queryResolver[camelCasedType] = (_, args) => realm.objectForPrimaryKey(type, args[pk.name]);
        return `${camelCasedType}(${pk.name}: ${pk.type}): ${type}\n`;
    }

    private setupUpdateObject(mutationResolver: IResolverObject, type: string, realm: Realm): string {
        // TODO: validate that the PK is set
        // TODO: validate that object exists, otherwise it's addOrUpdate not just update
        mutationResolver[`update${type}`] = (_, args) => {
            let result: any;
            realm.write(() => {
                result = realm.create(type, args.input, true);
            });

            return result;
        };

        return `update${type}(input: ${type}Input): ${type}\n`;
    }

    private setupDeleteObject(mutationResolver: IResolverObject, type: string, realm: Realm, pk: PKInfo): string {
        mutationResolver[`delete${type}`] = (_, args) => {
            let result: boolean = false;
            realm.write(() => {
                let obj = realm.objectForPrimaryKey(type, args[pk.name]);
                if (obj) {
                    realm.delete(obj);
                    result = true;
                }
            });

            return result;
        };

        return `delete${type}(${pk.name}: ${pk.type}): Boolean\n`;
    }

    private getPropertySchema(obj: ObjectSchema): PropertySchemaInfo {
        let schemaProperties = '';
        let inputSchemaProperties = '';
        let primaryKey: PKInfo = null;

        for (const key in obj.properties) {
            if (!obj.properties.hasOwnProperty(key)) {
                continue;
            }

            const prop = obj.properties[key] as ObjectSchemaProperty;
            if (prop.type === 'linkingObjects') {
                continue;
            }

            let types = this.getTypeString(prop);

            schemaProperties += `${key}: ${types.type}\n`;
            inputSchemaProperties += `${key}: ${types.inputType}\n`

            if (key === obj.primaryKey) {
                primaryKey = {
                    name: key,
                    type: types.type
                };
            }
        }

        return {
            propertySchema: schemaProperties,
            inputPropertySchema: inputSchemaProperties,
            pk: primaryKey
        };
    }

    private getTypeString(prop: ObjectSchemaProperty): SchemaTypes {
        let type: string;
        let inputType: string;
        switch (prop.type) {
            case 'object':
                type = prop.objectType;
                inputType = `${prop.objectType}Input`;
                break;
            case 'list':
                let innerType = this.getPrimitiveTypeString(prop.objectType, prop.optional);
                if (!innerType) {
                    innerType = prop.objectType;
                }
                type = `[${innerType}]`;
                inputType = `[${innerType}Input]`;
                break;
            default:
                type = inputType = this.getPrimitiveTypeString(prop.type, prop.optional);
                break;
        }

        return {
            type: type,
            inputType: inputType
        }
    }

    private getPrimitiveTypeString(prop: string, optional: Boolean): string {
        let result = '';
        switch (prop) {
            case 'bool':
                result = 'Boolean';
                break;
            case 'int':
                result = 'Int';
                break;
            case 'float':
            case 'double':
                result = 'Float';
                break;
            case 'date':
            case 'string':
            case 'data':
                result = 'String';
                break;
            default:
                return null;
        }

        if (!optional) {
            result += '!';
        }

        return result;
    }

    camelcase(value: string) : string {
        return value.charAt(0).toLowerCase() + value.slice(1);
    }
}