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
        return buildSchema(`
            type Query {
                hello: String
            }
        `);
    }
}