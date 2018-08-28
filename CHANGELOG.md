# NEXT RELEASE

### Enhancements
* Added a configuration option to include the objects matching the query in the collection response. It is not
`true` by default because it changes the response type slightly, which would break existing clients. It can be
enabled by passing `includeCountInResponses: true` in the `GraphQLService` constructor.

### Bug fixes

### Breaking Changes

# 3.1.1

### Enhancements
* Queries and mutations over websocket are now supported.

# 3.0.0

### Breaking Changes
* Types that are plural nouns will now have forced `s` appended to the actions that would otherwise have been plural to distinguish from the singular action. For example having a type `Data` would have previously generated actions:
  ```
  Query {
    data(query, sortBy, descending, skip, take): [Data!]
  }

  Mutation {
    deleteData(query): Int
  }
  ```

  which would have produced conflicting actions when the type also had a primary key. Now we'll generate actions with grammatically incorrect name - `datas` - which will, however, be distinct from any actions that were acting on the singular value:

  ```
  Query {
    datas(query, sortBy, descending, skip, take): [Data!]
    // If we have a PK
    data(pk): Data
  }

  Mutation {
    deleteDatas(query): Int
    // If we have a PK
    deleteData(pk): Boolean
  }
  ```

# 2.6.0

### Enhancements
* Expose option to force the explorer to use SSL for websockets.

# 2.5.2

### Bug fixes
* Applied the CORS middleware to the GraphQL service.

# 2.5.1

### Bug fixes
* Fixed an issue that caused querying realms with types/properties that started with double underscores to throw
an obscure type error.

# 2.5.0

### Enahancements
* Updated dependencies to their latest versions to avoid the issue with the `@types/graphql` package missing.

# 2.4.0

### Enhancements
* Schema cache will be preemptively invalidated if the Realm is open while the schema change takes place. You still need
to manually invalidate it if you change the schema of a Realm that is not open by the GraphQL service.

### Bug fixes
* The Realm schema will be properly updated after cache invalidation.

# 2.3.2

### Bug fixes
* Fixed a bug that caused subscriptions to trigger for unrelated changes.

# 2.3.1

### Bug fixes
* Fixed a bug that would prevent admin refresh tokens to be used as authentication.
