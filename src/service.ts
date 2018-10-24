import { ExpressHandler, graphiqlExpress, graphqlExpress } from "apollo-server-express";
import { GraphiQLData } from "apollo-server-module-graphiql";
import * as express from "express";
import { execute, GraphQLError, GraphQLScalarType, GraphQLSchema, subscribe } from "graphql";
import { PubSub } from "graphql-subscriptions";
import { makeExecutableSchema } from "graphql-tools";
import { IResolverObject } from "graphql-tools/dist/Interfaces";
import * as LRU from "lru-cache";
import * as moment from "moment";
import * as pluralize from "pluralize";
import { ObjectSchema, ObjectSchemaProperty } from "realm";
import {
    AccessToken,
    AdminRealm,
    BaseRoute,
    Cors,
    Delete,
    errors,
    extractPartialInfo,
    Get,
    isAdminToken,
    Next,
    Post,
    RefreshToken,
    Request,
    Response,
    RosRequest,
    Server,
    ServerStarted,
    Start,
    Stop,
    Token,
    Upgrade,
    User,
} from "realm-object-server";
import { SubscriptionServer } from "subscriptions-transport-ws";
import { setTimeout } from "timers";
import * as url from "url";
import { v4 } from "uuid";

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

interface SubscriptionDetails {
  results: Realm.Results<{}>;
  realm: Realm;
}

interface GraphQLRequest extends RosRequest {
  user: Realm.Sync.User;
}

interface GraphQLContext {
  accessToken: Token;
  user: Realm.Sync.User;
  realm?: Realm;
  operationId?: string;
}

/**
 * Settings to control the [[GraphQLService]] behavior.
 */
export interface GraphQLServiceSettings {
  /**
   * Settings controlling the schema caching strategy. If set to `'NoCache'`,
   * Realm schemas will not be cached and instead generated on every request.
   * This is useful while developing and schemas may change frequently, but
   * drastically reduces performance. If not set, or set to a [[SchemaCacheSettings]]
   * instance, schemas will be cached.
   */
  schemaCacheSettings?: SchemaCacheSettings | "NoCache";

  /**
   * Disables authentication for graphql endpoints. This may be useful when
   * you are developing the app and want a more relaxed exploring experience.
   * If you're using studio to explore the graphql API and responses, it will
   * handle authentication for you, so there's no need to disable it.
   */
  disableAuthentication?: boolean;

  /**
   * Disables the grahpiql explorer endpoint (`/grahpql/explore`).
   */
  disableExplorer?: boolean;

  /**
   * The number in milliseconds which a Realm will be kept open after a request
   * has completed. Higher values mean that more Realms will be kept in the cache,
   * drastically improving the response times of requests hitting "warm" Realms.
   * This, however, comes at the cost of increased memory usage. If a negative value
   * is provided, the realms will never be evicted from the cache. Default is
   * 120000 (2 minutes).
   */
  realmCacheMaxAge?: number;

  /**
   * Controls whether the explorer websocket connections will be made over SSL or
   * not. If not set, the service will try to infer the correct value from the
   * request protocol, but in some cases, a load balancer may terminate https traffic,
   * leading to incorrect websocket protocol being used.
   */
  forceExplorerSSL?: boolean;

  /**
   * Controls whether the total count of the objects matched by the query will be
   * returned as a property in the query and subscription responses. Default is false.
   */
  includeCountInResponses?: boolean;

  /**
   * Controls whether integers in the schema will be represented as Floats in the GraphQL
   * schema. GraphQL's integer type is 32 bit which means that it can't hold values larger
   * than 2,147,483,647. Representing them as floats expands the range to 2^53 - 1, but
   * prevents tools from properly enforcing type safety. This means that type mismatch
   * errors (e.g. a floating point number is passed in a mutation instead of an integer)
   * will get thrown further down the stack and may be harder to interpret. Default is false.
   */
  presentIntsAsFloatsInSchema?: boolean;
}

/**
 * Settings controlling the schema caching strategy.
 */
export interface SchemaCacheSettings {
  /**
   * The number of schemas to keep in the cache. Default is 1000.
   */
  max?: number;

  /**
   * The max age for schemas in cache. Default is infinite.
   */
  maxAge?: number;
}

const Base64Type = new GraphQLScalarType({
  name: "Base64",
  description: "A base64-encoded binary blob",
  serialize(value) {
    return Buffer.from(value).toString("base64");
  },
  parseValue(value) {
    return Buffer.from(value, "base64");
  },
  parseLiteral(ast) {
    if (ast.kind === "StringValue") {
      return Buffer.from(ast.value, "base64");
    }

    throw new TypeError(`Expected StringValue literal, but got ${ast.kind}`);
  },
});

/**
 * A service that exposes a GraphQL API for accessing the Realm files.
 * Create a new instance and pass it to `BasicServer.addService` before
 * calling `BasicServer.start`
 *
 * @example
 * ```
 *
 * const service = new GraphQLService({
 *   // Enable schema caching to improve performance
 *   schemaCacheSettings: {}
 * });
 *
 * server.addService(service);
 *
 * server.start();
 * ```
 */
@BaseRoute("/graphql")
@Cors("/")
export class GraphQLService {
  private readonly schemaCache: LRU.Cache<string, GraphQLSchema>;
  private readonly disableAuthentication: boolean;
  private readonly realmCacheTTL: number;
  private readonly disableExplorer: boolean;
  private readonly schemaHandlers: { [path: string]: (realm: Realm, event: string, schema: Realm.ObjectSchema[]) => void } = {};
  private readonly forceExplorerSSL: boolean | undefined;
  private readonly includeCountInResponses: boolean;
  private readonly presentIntsAsFloatsInSchema: boolean;

  private server: Server;
  private subscriptionServer: SubscriptionServer;
  private handler: ExpressHandler;
  private graphiql: ExpressHandler;
  private pubsub: PubSub;
  private querySubscriptions: { [id: string]: SubscriptionDetails } = {};
  private adminRealm: Realm;

  /**
   * Creates a new `GraphQLService` instance.
   * @param settings Settings, controlling the behavior of the service related
   * to caching and authentication.
   */
  constructor(settings?: GraphQLServiceSettings) {
    settings = settings || {};

    if (settings.schemaCacheSettings !== "NoCache") {
      this.schemaCache = new LRU({
        max: (settings.schemaCacheSettings && settings.schemaCacheSettings.max) || 1000,
        maxAge: settings.schemaCacheSettings && settings.schemaCacheSettings.maxAge,
      });
    }

    this.disableAuthentication = settings.disableAuthentication || false;
    this.disableExplorer = settings.disableExplorer || false;
    this.realmCacheTTL = settings.realmCacheMaxAge || 120000;
    this.forceExplorerSSL = settings.forceExplorerSSL;
    this.includeCountInResponses = settings.includeCountInResponses || false;
    this.presentIntsAsFloatsInSchema = settings.presentIntsAsFloatsInSchema || false;
  }

  @ServerStarted()
  private serverStarted(server: Server) {
    this.server = server;
    this.pubsub = new PubSub();

    const getOperationId = (socket: any, messageId: string) => {
      // socket.id is set to a random value in `onOperation`
      return `${socket.id}_${messageId}`;
    };

    this.subscriptionServer = new SubscriptionServer(
      {
        execute,
        subscribe,
        onOperationComplete: (socket, messageId) => {
          const opid = getOperationId(socket, messageId);
          const details = this.querySubscriptions[opid];
          if (details) {
            details.results.removeAllListeners();
            this.closeRealm(details.realm);
            delete this.querySubscriptions[opid];
          }
        },
        onOperation: async (message, params, socket) => {
          // HACK: socket.realmPath is set in subscriptionHandler to the
          // :path route parameter
          if (!socket.realmPath) {
            throw new GraphQLError('Missing "realmPath" from context. It is required for subscriptions.');
          }

          socket.id = v4();
          const context = params.context as GraphQLContext;
          context.operationId = getOperationId(socket, message.id);
          context.realm = await this.openRealm(socket.realmPath, context.user);
          params.schema = this.getSchema(socket.realmPath, context.realm);
          return params;
        },
        onConnect: async (authPayload, socket): Promise<GraphQLContext> => {
          let accessToken: Token;
          let user: Realm.Sync.User;
          if (!this.disableAuthentication) {
            if (!authPayload || !authPayload.token) {
              throw new errors.realm.MissingParameters("Missing 'connectionParams.token'.");
            }

            accessToken = this.server.tokenValidator.parse(authPayload.token);
            user = await this.authenticate(accessToken, socket.realmPath);
          }

          return {
            accessToken,
            user,
          };
        },
      },
      {
        noServer: true,
      },
    );

    this.handler = graphqlExpress(async (req: GraphQLRequest, res) => {
      res.once("finish", () => {
        this.closeRealm(realm);
      });

      const path = this.getPath(req);
      const realm = await this.openRealm(path, req.user);
      const schema = this.getSchema(path, realm);

      const result: {
        schema: GraphQLSchema,
        context: GraphQLContext,
      } = {
        schema,
        context: {
          realm,
          accessToken: req.authToken,
          user: req.user,
        },
      };

      return result;
    });

    this.graphiql = graphiqlExpress((req: GraphQLRequest) => {
      const path = this.getPath(req);

      let protocol: string;
      switch (this.forceExplorerSSL) {
        case true:
          protocol = "wss";
          break;
        case false:
          protocol = "ws";
          break;
        default:
          protocol = req.protocol === "https" ? "wss" : "ws";
          break;
      }

      const result: GraphiQLData = {
        endpointURL: `/graphql/${encodeURIComponent(path)}`,
        subscriptionsEndpoint: `${protocol}://${req.get("host")}/graphql/${encodeURIComponent(path)}`,
      };

      const token = req.get("authorization");
      if (token) {
        result.passHeader = `'Authorization': '${token}'`;
        result.websocketConnectionParams = { token };
      }

      return result;
    });
  }

  @Start()
  private async start(server: Server) {
    this.adminRealm = await server.openRealm(AdminRealm);
  }

  @Stop()
  private stop() {
    this.subscriptionServer.close();
  }

  @Upgrade("/:path+")
  private async subscriptionHandler(req, socket, head) {
    const wsServer = this.subscriptionServer.server;
    const ws = await new Promise<any>((resolve) => wsServer.handleUpgrade(req, socket, head, resolve));

    // HACK: we're putting the realmPath on the socket client
    // and resolving it in subscriptionServer.onOperation to
    // populate it in the subscription context.
    const path = url.parse(req.url).path.replace("/graphql/", "");
    ws.realmPath = this.getPath(path);
    wsServer.emit("connection", ws, req);
  }

  @Get("/explore/*")
  private async getExplore(@Request() req: GraphQLRequest, @Response() res: express.Response, @Next() next) {
    if (this.disableExplorer) {
      throw new errors.realm.AccessDenied();
    }

    await this.authenticateRequest(req);
    this.graphiql(req, res, next);
  }

  @Post("/explore/*")
  private async postExplore(@Request() req: GraphQLRequest, @Response() res: express.Response, @Next() next) {
    if (this.disableExplorer) {
      throw new errors.realm.AccessDenied();
    }

    await this.authenticateRequest(req);
    this.graphiql(req, res, next);
  }

  @Get("/*")
  private async get(@Request() req: GraphQLRequest, @Response() res: express.Response, @Next() next) {
    await this.authenticateRequest(req);
    this.handler(req, res, next);
  }

  @Post("/*")
  private async post(@Request() req: GraphQLRequest, @Response() res: express.Response, @Next() next) {
    await this.authenticateRequest(req);
    this.handler(req, res, next);
  }

  @Delete("/schema/*")
  private deleteSchema(@Request() req: GraphQLRequest, @Response() res: express.Response) {
    this.authenticateRequest(req);
    this.schemaCache.del(this.getPath(req));
    res.status(204).send({});
  }

  private getPath(reqOrPath: GraphQLRequest | string): string {
    let path = typeof reqOrPath === "string" ? decodeURIComponent(reqOrPath) : reqOrPath.params["0"];
    if (!path.startsWith("/")) {
      path = `/${path}`;
    }

    return path;
  }

  private async authenticateRequest(req: GraphQLRequest): Promise<void> {
    req.user = await this.authenticate(req.authToken, this.getPath(req));
  }

  /**
   * Ensures the user is authenticated.
   * @param authToken token as set by the authentication middleware
   * @param path the optional path to look for in the access token.
   * If not provided, only admin tokens are accepted.
   */
  private async authenticate(authToken: Token, path?: string): Promise<Realm.Sync.User> {
    if (this.disableAuthentication) {
      return undefined;
    }

    if (!authToken) {
      throw new errors.realm.AccessDenied({ detail: "Authorization header is missing." });
    }

    const accessToken = authToken as AccessToken;
    if (!isAdminToken(authToken) && (!path || accessToken.path !== path)) {
      throw new errors.realm.InvalidCredentials({ detail: "The access token doesn't grant access to the requested path." });
    }

    const partialInfo = extractPartialInfo(path);
    if (!partialInfo.isPartial) {
      // Full Realm - we don't need user impersonation, so just return undefined to
      // make RealmFactory use the admin user
      return undefined;
    }

    if (!partialInfo.customIdentifier.startsWith(authToken.identity + "/")) {
      // We enforce that users only open their own Realms.
      throw new errors.realm.InvalidCredentials({
        detail: "The identifier after /__partial/ in the route must match the user Id. Expected: "
              + `'/__partial/${authToken.identity}/*', but got '/__partial/${partialInfo.customIdentifier}'.`,
      });
    }

    // TODO: optimize that - either cache it or check if the Realm exists in the factory.
    const adminRealmUser = this.adminRealm.objectForPrimaryKey<User>("User", authToken.identity);

    const refreshToken = new RefreshToken({
      appId: authToken.appId,
      identity: authToken.identity,
      isAdmin: (adminRealmUser && adminRealmUser.isAdmin) || false,
      expires: moment().add(1, "year").unix(),
    });

    // TODO: allow internal https traffic.
    const authService = await this.server.discovery.waitForService("auth");
    const user = Realm.Sync.User.deserialize({
      identity: refreshToken.identity,
      isAdmin: refreshToken.isAdmin,
      refreshToken: refreshToken.sign(this.server.privateKey),
      server: `http://${authService.address}:${authService.port}`,
    });

    return user;
  }

  private validateAccess(context: GraphQLContext, access: string) {
    if (this.disableAuthentication || isAdminToken(context.accessToken)) {
      return;
    }

    const token = context.accessToken as AccessToken;
    if (!token || !token.access || token.access.indexOf(access) < 0) {
      throw new errors.realm.InvalidCredentials({
        title: `The current user doesn't have '${access}' access.`,
      });
    }
  }

  private closeRealm(realm: Realm) {
    if (!realm) {
      return;
    }

    if (this.realmCacheTTL >= 0) {
      setTimeout(() => realm.close(), this.realmCacheTTL);
    } else {
      realm.close();
    }
  }

  private validateRead(context: GraphQLContext) {
    this.validateAccess(context, "download");
  }

  private validateWrite(context: GraphQLContext) {
    this.validateAccess(context, "upload");
  }

  private getSchema(path: string, realm: Realm): GraphQLSchema {
    if (this.schemaCache && this.schemaCache.has(path)) {
      return this.schemaCache.get(path);
    }

    let schema = `\nscalar ${Base64Type.name}\n`;

    const types = new Array<[string, PKInfo]>();
    const queryResolver: IResolverObject = {};
    const mutationResolver: IResolverObject = {};
    const subscriptionResolver: IResolverObject = {};
    const partialInfo = extractPartialInfo(path);

    for (const obj of realm.schema) {
      if (this.isReserved(obj.name)) {
        continue;
      }

      const propertyInfo = this.getPropertySchema(obj);

      if (!propertyInfo.propertySchema) {
        // If the object doesn't have properties, we don't want it.
        continue;
      }

      types.push([obj.name, propertyInfo.pk]);

      schema += `type ${obj.name} { \n${propertyInfo.propertySchema}}\n\n`;
      schema += `type ${obj.name}Collection {
        count: Int!
        items: [${obj.name}!]
      }\n`;
      schema += `input ${obj.name}Input { \n${propertyInfo.inputPropertySchema}}\n\n`;
    }

    if (types.length === 0) {
      throw new Error(`The schema for Realm at path ${path} is empty.`);
    }

    let query = "type Query {\n";
    let mutation = "type Mutation {\n";
    let subscription = "type Subscription {\n";

    if (partialInfo.isPartial) {
      schema += `type NamedSubscription {
        name: String,
        objectType: String!,
        query: String!
      }\n`;
      schema += `type NamedSubscriptionCollection {
        count: Int!
        items: [NamedSubscription!]
      }\n`;

      query += this.setupListPartialSubscriptions(queryResolver);
      mutation += this.setupDeletePartialSubscription(mutationResolver);
    }

    for (const [type, pk] of types) {
      // TODO: this assumes types are PascalCase
      const camelCasedType = this.camelcase(type);
      const pluralType = this.pluralize(camelCasedType);

      query += this.setupGetAllObjects(queryResolver, type, pluralType);
      mutation += this.setupAddObject(mutationResolver, type);
      mutation += this.setupDeleteObjects(mutationResolver, type);

      if (partialInfo.isPartial) {
        mutation += this.setupCreatePartialSubscription(mutationResolver, type);
      }

      subscription += this.setupSubscribeToQuery(subscriptionResolver, type, pluralType);

      // If object has PK, we add get by PK and update option.
      if (pk) {
        query += this.setupGetObjectByPK(queryResolver, type, camelCasedType, pk);
        mutation += this.setupUpdateObject(mutationResolver, type);
        mutation += this.setupDiffUpdateObject(mutationResolver, type);
        mutation += this.setupDeleteObject(mutationResolver, type, pk);
      }
    }

    query += "}\n\n";
    mutation += "}\n\n";
    subscription += "}";

    schema += query;
    schema += mutation;
    schema += subscription;

    const result = makeExecutableSchema({
      typeDefs: schema,
      resolvers: {
        Query: queryResolver,
        Mutation: mutationResolver,
        Subscription: subscriptionResolver,
        [Base64Type.name]: Base64Type,
      },
    });

    if (this.schemaCache) {
      this.schemaCache.set(path, result);
    }

    return result;
  }

  private setupGetAllObjects(queryResolver: IResolverObject, type: string, pluralType: string): string {
    queryResolver[pluralType] = (_, args, context: GraphQLContext) => {
      this.validateRead(context);

      let result = context.realm.objects(type);
      if (args.query) {
        result = result.filtered(args.query);
      }

      if (args.sortBy) {
        const descending = args.descending || false;
        result = result.sorted(args.sortBy, descending);
      }

      return this.getCollectionResponse(result, args);
    };

    // TODO: limit sortBy to only valid properties
    const responseType = this.includeCountInResponses ? `${type}Collection` : `[${type}!]`;
    return `${pluralType}(query: String, sortBy: String, descending: Boolean, skip: Int, take: Int): ${responseType}\n`;
  }

  private setupAddObject(mutationResolver: IResolverObject, type: string): string {
    mutationResolver[`add${type}`] = (_, args, context: GraphQLContext) => {
      this.validateWrite(context);

      let result: any;
      context.realm.write(() => {
        result = context.realm.create(type, args.input);
      });

      return result;
    };

    return `add${type}(input: ${type}Input): ${type}\n`;
  }

  private setupSubscribeToQuery(subscriptionResolver: IResolverObject, type: string, pluralType: string): string {
    subscriptionResolver[pluralType] = {
      subscribe: (_, args, context: GraphQLContext) => {
        this.validateRead(context);

        let result = context.realm.objects(type);
        if (args.query) {
          result = result.filtered(args.query);
        }

        if (args.sortBy) {
          const descending = args.descending || false;
          result = result.sorted(args.sortBy, descending);
        }

        const opId = context.operationId;
        this.querySubscriptions[opId] = {
          results: result,
          realm: context.realm,
        };

        result.addListener((collection, change) => {
          const payload = {};
          payload[pluralType] = this.getCollectionResponse(collection, args);
          this.pubsub.publish(opId, payload);
        });

        return this.pubsub.asyncIterator(opId);
      },
    };

    // TODO: limit sortBy to only valid properties
    const responseType = this.includeCountInResponses ? `${type}Collection` : `[${type}!]`;
    return `${pluralType}(query: String, sortBy: String, descending: Boolean, skip: Int, take: Int): ${responseType}\n`;
  }

  private setupGetObjectByPK(queryResolver: IResolverObject, type: string, camelCasedType: string, pk: PKInfo): string {
    queryResolver[camelCasedType] = (_, args, context: GraphQLContext) => {
      this.validateRead(context);

      return context.realm.objectForPrimaryKey(type, args[pk.name]);
    };
    return `${camelCasedType}(${pk.name}: ${pk.type}): ${type}\n`;
  }

  private setupUpdateObject(mutationResolver: IResolverObject, type: string): string {
    // TODO: validate that the PK is set
    // TODO: validate that object exists, otherwise it's addOrUpdate not just update
    mutationResolver[`update${type}`] = (_, args, context: GraphQLContext) => {
      this.validateWrite(context);

      let result: any;
      context.realm.write(() => {
        result = context.realm.create(type, args.input, true);
      });

      return result;
    };

    return `update${type}(input: ${type}Input): ${type}\n`;
  }

  private setupDiffUpdateObject(mutationResolver: IResolverObject, type: string): string {
    mutationResolver[`diffUpdate${type}`] = (_, args, context: GraphQLContext) => {
      this.validateWrite(context);

      try {
        const response = this.upsertObject(context, args.input, type);
        return response.result;
      } catch (err) {
        if (context.realm.isInTransaction) {
          context.realm.cancelTransaction();
        }

        throw err;
      }
    };

    return `diffUpdate${type}(input: ${type}Input): ${type}\n`;
  }

  private setupDeleteObject(mutationResolver: IResolverObject, type: string, pk: PKInfo): string {
    mutationResolver[`delete${type}`] = (_, args, context: GraphQLContext) => {
      this.validateWrite(context);

      let result: boolean = false;
      context.realm.write(() => {
        const obj = context.realm.objectForPrimaryKey(type, args[pk.name]);
        if (obj) {
          context.realm.delete(obj);
          result = true;
        }
      });

      return result;
    };

    return `delete${type}(${pk.name}: ${pk.type}): Boolean\n`;
  }

  private setupDeleteObjects(mutationResolver: IResolverObject, type: string): string {
    const pluralType = this.pluralize(type);

    mutationResolver[`delete${pluralType}`] = (_, args, context: GraphQLContext) => {
      this.validateWrite(context);

      let result: number;
      context.realm.write(() => {
        let toDelete = context.realm.objects(type);
        if (args.query) {
          toDelete = toDelete.filtered(args.query);
        }

        result = toDelete.length;
        context.realm.delete(toDelete);
      });

      return result;
    };

    return `delete${pluralType}(query: String): Int\n`;
  }

  private setupCreatePartialSubscription(mutationResolver: IResolverObject, type: string): string {
    mutationResolver[`create${type}Subscription`] = async (_, args, context: GraphQLContext) => {
      let result = context.realm.objects(type);
      if (args.query) {
        result = result.filtered(args.query);
      }

      if (args.sortBy) {
        const descending = args.descending || false;
        result = result.sorted(args.sortBy, descending);
      }

      const subscription = args.name ? result.subscribe(args.name) : result.subscribe();

      await new Promise((resolve, reject) => {
        subscription.addListener((s, state) => {
          switch (state) {
            case Realm.Sync.SubscriptionState.Complete:
              subscription.removeAllListeners();
              resolve();
              break;
            case Realm.Sync.SubscriptionState.Error:
              subscription.removeAllListeners();
              reject(subscription.error);
              break;
          }
        });
      });

      return this.getCollectionResponse(result, {});
    };

    const responseType = this.includeCountInResponses ? `${type}Collection` : `[${type}!]`;
    return `create${type}Subscription(query: String, sortBy: String, descending: Boolean, name: String): ${responseType}\n`;
  }

  private setupListPartialSubscriptions(queryResolver: IResolverObject): string {
    queryResolver.queryBasedSubscriptions = async (_, args, context: GraphQLContext) => {
      const result = context.realm.subscriptions(args.name);
      return this.getCollectionResponse(result, {});
    };

    const responseType = this.includeCountInResponses ? "NamedSubscriptionCollection" : "[NamedSubscription!]";
    return `queryBasedSubscriptions(name: String): ${responseType}\n`;
  }

  private setupDeletePartialSubscription(mutationResolver: IResolverObject): string {
    mutationResolver.deleteQueryBasedSubscription = async (_, args, context: GraphQLContext) => {
      context.realm.unsubscribe(args.name);
      return true;
    };

    return "deleteQueryBasedSubscription(name: String!): Boolean\n";
  }

  private upsertObject(
    context: GraphQLContext,
    newObject: any,
    type: string,
    shouldBeginTransaction = true,
  ): {
    result: any,
    hasChanges: boolean,
  } {
    const objectSchema = context.realm.schema.find((s) => s.name === type);
    const pkName = objectSchema.primaryKey;
    const pkValue = newObject[pkName];
    let result = context.realm.objectForPrimaryKey(type, pkValue);

    let hasChanges = false;
    if (shouldBeginTransaction) {
      context.realm.beginTransaction();
    }

    if (!result) {
      // TODO: this can be improved by not recreating linked objects
      result = context.realm.create(type, newObject, true);
      hasChanges = true;
    } else {
      for (const propertyName of Object.getOwnPropertyNames(objectSchema.properties)) {
        if (newObject[propertyName] === undefined || propertyName === pkName) {
          continue;
        }

        const prop = objectSchema.properties[propertyName] as Realm.ObjectSchemaProperty;
        switch (prop.type) {
          case "object":
            const link = this.upsertObject(context, newObject[propertyName], prop.objectType, false);
            hasChanges = hasChanges || link.hasChanges;
            if (!result[propertyName]._isSameObject(link.result)) {
              hasChanges = true;
              result[propertyName] = link.result;
            }
            break;
          case "date":
            if (!this.datesEqual(result[propertyName], newObject[propertyName])) {
              hasChanges = true;
              result[propertyName] = newObject[propertyName];
            }
            break;
          case "list":
            // TODO do a better diff
            hasChanges = true;
            result[propertyName] = [];
            for (const item of newObject[propertyName]) {
                const upserted = this.upsertObject(context, item, prop.objectType, false);
                result[propertyName].push(upserted.result);
            }
            break;
          default:
            if (result[propertyName] !== newObject[propertyName]) {
              hasChanges = true;
              result[propertyName] = newObject[propertyName];
            }
            break;
        }
      }
    }

    if (shouldBeginTransaction) {
      if (hasChanges) {
        context.realm.commitTransaction();
      } else {
        context.realm.cancelTransaction();
      }
    }

    return {
        result,
        hasChanges,
    };
  }

  private getPropertySchema(obj: ObjectSchema): PropertySchemaInfo {
    let schemaProperties = "";
    let inputSchemaProperties = "";
    let primaryKey: PKInfo = null;

    for (const key in obj.properties) {
      if (!obj.properties.hasOwnProperty(key) ||
          this.isReserved(key)) {
        continue;
      }

      const prop = obj.properties[key] as ObjectSchemaProperty;
      if (prop.type === "linkingObjects") {
        continue;
      }

      const types = this.getTypeString(prop);
      if (!types || this.isReserved(types.type)) {
        continue;
      }

      schemaProperties += `${key}: ${types.type}\n`;
      inputSchemaProperties += `${key}: ${types.inputType}\n`;

      if (key === obj.primaryKey) {
        primaryKey = {
          name: key,
          type: types.type,
        };
      }
    }

    return {
      propertySchema: schemaProperties,
      inputPropertySchema: inputSchemaProperties,
      pk: primaryKey,
    };
  }

  private getTypeString(prop: ObjectSchemaProperty): SchemaTypes {
    let type: string;
    let inputType: string;
    switch (prop.type) {
      case "object":
        type = prop.objectType;
        inputType = `${prop.objectType}Input`;
        break;
      case "list":
        const innerType = this.getPrimitiveTypeString(prop.objectType, prop.optional);
        if (this.isReserved(innerType)) {
          return undefined;
        }
        type = `[${innerType}]`;

        switch (prop.objectType) {
          case "bool":
          case "int":
          case "float":
          case "double":
          case "date":
          case "string":
          case "data":
            inputType = type;
            break;
          default:
            inputType = `[${innerType}Input]`;
            break;
        }
        break;
      default:
        type = this.getPrimitiveTypeString(prop.type, prop.optional);
        inputType = this.getPrimitiveTypeString(prop.type, true);
        break;
    }

    return {
      type,
      inputType,
    };
  }

  private getPrimitiveTypeString(prop: string, optional: boolean): string {
    let result = "";
    switch (prop) {
      case "bool":
        result = "Boolean";
        break;
      case "int":
        result = this.presentIntsAsFloatsInSchema ? "Float" : "Int";
        break;
      case "float":
      case "double":
        result = "Float";
        break;
      case "date":
      case "string":
        result = "String";
        break;
      case "data":
        result = Base64Type.name;
        break;
      default:
        return prop;
    }

    if (!optional) {
      result += "!";
    }

    return result;
  }

  private getCollectionResponse(collection: any, args: { skip?: number, take?: number }): any {
    let result = collection;
    if (args.skip || args.take) {
      const skip = args.skip || 0;
      const take = args.take ? (args.take + skip) : undefined;
      result = collection.slice(skip, take);
    }

    if (this.includeCountInResponses) {
      return {
        count: collection.length,
        items: result,
      };
    }

    return result;
  }

  private camelcase(value: string): string {
    return value.charAt(0).toLowerCase() + value.slice(1);
  }

  private pluralize(value: string): string {
    const result = pluralize(value);
    if (result !== value) {
      return result;
    }

    return result + "s";
  }

  private isReserved(value: string): boolean {
    return value.startsWith("__");
  }

  private datesEqual(first: Date, second: Date): boolean {
    try {
      if (first === null || second === null) {
        return first === second;
      }

      if (!(first instanceof Date)) {
        first = new Date(first);
      }

      if (!(second instanceof Date)) {
        second = new Date(second);
      }

      return first.getTime() === second.getTime();
    } catch (err) {
      return false;
    }
  }

  private async openRealm(path: string, user: Realm.Sync.User): Promise<Realm> {
    const realm = await this.server.openRealm({
      remotePath: path,
      schema: undefined,
      user,
    });

    if (this.schemaCache) {
      realm.addListener("schema", this.getSchemaHandler(path));
    }

    return realm;
  }

  private getSchemaHandler(path: string): (realm: Realm, event: string, schema: Realm.ObjectSchema[]) => void {
    let value = this.schemaHandlers[path];
    if (!value) {
      value = (realm: Realm, event: string, schema: Realm.ObjectSchema[]) => {
        try {
          this.schemaCache.del(path);
          this.getSchema(path, realm);
        } catch {
          // Ignore
        }
      };
      this.schemaHandlers[path] = value;
    }

    return value;
  }
}
