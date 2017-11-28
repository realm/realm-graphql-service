import {
    BaseRoute,
    Get,
    Post,
    Put,
    Delete,
    Query,
    Params,
    ServerStarted,
    Server,
    Body,
    Request,
    Response
} from 'realm-object-server'

import {
    Source,
    parse,
    validate,
    execute,
    formatError,
    getOperationAST,
    specifiedRules,
} from 'graphql';

import * as GraphQLHTTP from 'express-graphql';

import { DocumentNode, GraphQLError, GraphQLSchema, GraphQLObjectType, buildSchema } from 'graphql';
import { ObjectSchemaProperty } from 'realm';

function getSchemaFromRealmByObjectName(realm: Realm, objectName: string): Realm.ObjectSchema | undefined {
    return realm.schema.find(s => s.name === objectName)
}

@BaseRoute('/graphql')
export class GraphQLService {
    server: Server
    
    @ServerStarted()
    serverStarted(server: Server) {
        this.server = server;
    }

    @Get('/:path')
    async get(@Params('path') path: string,
        @Request() req, 
        @Response() res) {
        await this.handleGraphQLRequest(path, req, res);
    }

    @Post('/:path')
    async post(@Params('path') path: string,
        @Request() req, 
        @Response() res) {
        await this.handleGraphQLRequest(path, req, res);
    }

    async handleGraphQLRequest(path: string, request: any, response: any) {
        let schema = await this.getSchema(path);
        GraphQLHTTP({
            schema: schema,
            rootValue: {
                hello: () => { return path }
            },
            graphiql: true,
        })(request, response);
    }

    async getSchema(path: string) : Promise<GraphQLSchema> {
        let realm = await this.server.openRealm(path)

        let schema = '';
        let types = new Array<string>();

        for (const obj of realm.schema) {
            schema += `type ${obj.name} {\n`;

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
                            if (innerType === null) {
                                innerType = prop.objectType;
                            }
                            type = `[${innerType}]`;
                            break;
                        default:
                            type = this.getTypeString(prop.type, prop.optional);
                            break;
                    }

                    schema += `    ${key}: ${type}\n`

                }
            }

            types.push(obj.name);
          
            schema += '}\n\n';
        }

        schema += 'type Query {\n';

        for (const type of types) {
            schema += `    ${this.camelcase(type)}: [${type}!]\n`
        }

        schema += '}';

        return buildSchema(schema);
    }

    getTypeString(prop: string, optional: Boolean): string {
        let result = '';
        switch (prop) {
            case 'bool':
                result = 'Boolean';
                break;
            case 'int':
            case 'date':
                result = 'Int';
                break;
            case 'float':
            case 'double':
                result = 'Float';
                break;
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