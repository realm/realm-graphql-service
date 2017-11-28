import { BasicServer } from 'realm-object-server'
import * as path from 'path'
import { GraphQLService } from './service'

const server = new BasicServer()

server.addService(new GraphQLService());

server.start({
        dataPath: path.join(__dirname, '../data'),
    })
    .then(() => {
        console.log(`Realm Object Server was started on ${server.address}`)
    })
    .catch(err => {
        console.error(`Error starting Realm Object Server: ${err.message}`)
    })
