## Realm GraphQL Service

This library provides a service that can be added to your Realm Object Server
to expose GraphQL API for querying, mutating, and subscribing to synchronized
Realms.

To enable the service, create a new project by running `ros init` and install
the `realm-graphql-service` package:

```
ros init my-project
cd my-project
npm install realm-graphql-service --save
```

Then modify the generated `src/index.ts` file to look like this:

```ts
import { BasicServer } from 'realm-object-server'
import * as path from 'path'
import { GraphQLService } from 'realm-graphql-service'

const server = new BasicServer();

// Add the GraphQL service to ROS
server.addService(new GraphQLService({
  // Turn this off in production!
  disableAuthentication: true
}));

server.start({
    // Server configs...
  })
  .then(() => {
    console.log(`Realm Object Server was started on ${server.address}`)
  })
  .catch(err => {
    console.error(`Error starting Realm Object Server: ${err.message}`)
  });
```