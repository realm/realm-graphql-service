import { BaseRoute, Get, Post, ServerStarted, Server, Request, Response } from 'realm-object-server'
import { graphqlExpress, ExpressHandler, graphiqlExpress } from 'apollo-server-express';
import { DocumentNode, GraphQLError, GraphQLSchema, GraphQLObjectType, buildSchema } from 'graphql';
import { ObjectSchemaProperty } from 'realm';
import { makeExecutableSchema } from 'graphql-tools';
import { IResolverObject, IResolvers } from 'graphql-tools/dist/Interfaces';
import * as pluralize from 'pluralize'

function getSchemaFromRealmByObjectName(realm: Realm, objectName: string): Realm.ObjectSchema | undefined {
    return realm.schema.find(s => s.name === objectName)
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
        interface PKInfo { 
            name: string
            type: string
        }

        let schema = '';
        let types = new Array<[string, PKInfo]>();
        let queryResolver: IResolverObject = { };

        
        for (const obj of realm.schema) {
            schema += `type ${obj.name} {\n`;

            let primaryKey: PKInfo = null;

            for (const key in obj.properties) {
                if (obj.properties.hasOwnProperty(key)) {
                    const prop = obj.properties[key] as ObjectSchemaProperty;
                    if (prop.type === 'linkingObjects') {
                        continue;
                    }
                    let type = '';
                    switch (prop.type) {
                        case 'object':
                            type = prop.objectType;
                            break;
                        case 'list':
                            let innerType = this.getTypeString(prop.objectType, prop.optional);
                            if (!innerType) {
                                innerType = prop.objectType;
                            }
                            type = `[${innerType}]`;
                            break;
                        default:
                            type = this.getTypeString(prop.type, prop.optional);
                            break;
                    }

                    schema += `    ${key}: ${type}\n`;

                    if (key === obj.primaryKey) {
                        primaryKey = {
                            name: key,
                            type: type
                        };
                    }
                }
            }

            types.push([obj.name, primaryKey]);
          
            schema += '}\n\n';
        }

        schema += 'type Query {\n';
        
        for (const [type, pk] of types) {
            const camelCasedType = this.camelcase(type);
            const pluralType = pluralize(camelCasedType);

            // All objects
            queryResolver[pluralType] = (_, args) => {
                let result = realm.objects(type);
                if (args.query) {
                    result = result.filtered(args.query);
                }

                if (args.sortBy) {
                    let descending = args.descending || false;
                    result = result.sorted(args.sortBy, descending);
                }
                
                return result;
            };

            // TODO: limit sortBy to only valid properties
            schema += `    ${pluralType}(query: String, sortBy: String, descending: Boolean): [${type}!]\n`;

            // Get by PK
            if (pk) {
                queryResolver[camelCasedType] = (_, args) => realm.objectForPrimaryKey(type, args[pk.name]);
                schema += `    ${camelCasedType}(${pk.name}: ${pk.type}): ${type}\n`;
            }
        }

        schema += '}';

        return makeExecutableSchema({ 
            typeDefs: schema,
            resolvers: {
                Query: queryResolver
            }
        });
    }

    getTypeString(prop: string, optional: Boolean): string {
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