/* tslint:disable:no-console */

import * as path from "path";
import { BasicServer } from "realm-object-server";
import { GraphQLService } from "./service";

const server = new BasicServer();

server.addService(new GraphQLService({
  disableAuthentication: true,
}));

server
  .start({
    dataPath: path.join(__dirname, "../data"),
    jsonBodyLimit: "10mb",
  })
  .then(() => {
    console.log(`Realm Object Server was started on ${server.address}`);
  })
  .catch((err) => {
    console.error(`Error starting Realm Object Server: ${err.message}`);
  });
