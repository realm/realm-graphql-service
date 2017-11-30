# GraphQL API for Realm Object Server

This repo hosts a service that can be added to a Realm Object Server instance to expose a GraphQL API to read and update synchronized Realms.

## Usage

Clone the repo and run `npm start`. To debug the app, open the folder in Visual Studio Code and run the debugger (F5). Refer to [index.ts](https://github.com/realm/realm-object-server-graphql/blob/master/src/index.ts) for pointers on how to add it to an existing `ros init`-ed instance.

## Endpoints

The GraphQL endpoint is mounted on `/graphql/:path` where `path` is the path of the Realm.

The GraphiQL (visual exploratory tool) endpoint is mounted on `/graphql/explore/:path` where `path` again is the path of the Realm.

## Exploring

Run the app and navigate to http://localhost:9080/graphql/explore/%2F__admin - this will open the GraphiQL explorer for the `__admin` Realm.

### Querying

To query, you start with a `query` node. All possible query nodes should be suggested by the autocompletion engine. You must explicitly specify all properties/relationships of the returned objects.

- Querying all objects of a certain type: all object types have a pluralized node, e.g. `users`, `accounts`, etc. It accepts the following optional arguments:
  - `query`: a verbatim [realm.js query](https://realm.io/docs/javascript/latest/#filtering) that will be used to filter the returned dataset.
  - `sortBy`: a property on the object to sort by.
  - `descending`: sorting direction (default is false).
  - `skip`: offset to start taking objects from.
  - `take`: maximum number of items to return.
- Querying for object by primary key: object types that have a primary key defined will have a singularized node, e.g. `user`, `realmFile`, etc. It accepts a single argument that is the primary key of the object.

### Mutating

To mutate an object, start with a `mutation` node. All possible mutation methods should be suggested by the autompletion engine. The returned values are objects themselves, so again, you should explicitly specify the properties you're interested in.

- Adding objects: all object types have an `addObjectType` node, e.g. `addUser`, `addAccount`, etc. It accepts a single argument that is the object to add. Related objects will be added as well, e.g. specifying `accounts` in the `addUser` input will add the account objects.
- Updating objects: objects with primary key defined have an `updateObjectType` node, e.g. `updateUser`, `updateRealmFile`. It accepts a single argument that is the object to update. Partial updates are also allowed as long as the primary key value is specified.
- Deleting objects:
  - Objects with primary key defined have a `deleteObjectType` node, e.g. `deleteUder`, `deleteRealmFile`. It accepts a single argument that is the primary key of the object to delete. Returns `true` if object was deleted, `false` otherwise.
  - All object types have a `deleteObjectTypes` node, e.g. `deleteUsers`, `deleteAccounts`, etc. It accepts a single optional argument - `query` that will be used to filter objects to be deleted. If not supplied, all objects of this type will be deleted.
  
### Subscribing

To subscribe for change notifications, start with `subscription` node. The subscription endpoint is `ws://ROS-URL:19080/subscriptions` (eventually the port will be the same as the one used by ROS). Because schemas are different for different realms, you'll need to provide a [variable](http://graphql.org/learn/queries/#variables), called `realmPath` and set it to the path of the Realm you'd like to subscribe to. It will be used to dynamically resolve the schema upon subscription.

- Subscribing for queries: all object types have a pluralized node, e.g. `users`, `accounts`, etc. Every time an item is added, deleted, or modified in the dataset, the updated state will be pushed via the subscription socket. The node accepts the following optional arguments:
  - `query`: a verbatim [realm.js query](https://realm.io/docs/javascript/latest/#filtering) that will be used to filter the returned dataset.
  - `sortBy`: a property on the object to sort by.
  - `descending`: sorting direction (default is false).
  - `skip`: offset to start taking objects from.
  - `take`: maximum number of items to return.
  
#### Using GraphiQL with subscriptions

When you navigate to `http://localhost:9080/graphql/explore/:path`, we'll automatically populate the `"realmPath": ":path"` variable. Subscribe by creating a `subscription` node and whenever the Realm changes, an update will be pushed, containing the matching dataset. Additionally, immediately upon subscribing, the initial dataset will be sent.

### Inspecting the schema

You can see the schema of the Realm by querying the `__schema` node (it will also include some built-in GraphQL types):

```
{
  __schema {
    types {
      name
      fields {
        name
      }
    }
  }
}
```
