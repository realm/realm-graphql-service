# 3.3.0

### Enhancements
* Added a configuration option to represent integers as `Float` in the GraphQL schema. Since Realm integers
can be up to 64-bit and the GraphQL `Int` type is limited to 32-bits, this setting allows you to extend the
range of the numbers you can query to match javascript's limit (2^53 - 1). The downside is that you'll lose
the type checking and you may accidentally pass floats where integers are expected. Doing so will cause Realm
to automatically round the number down and treat it as an integer. To enable that option, pass
`presentIntsAsFloatsInSchema: true` in the `GraphQLService` constructor.

# 3.2.2

### Bug fixes
* Pinned the Apollo dependencies to 1.3.6 as 1.4.0 is breaking the GraphiQL explorer functionality.

# 3.2.1

### Bug fixes
* Fixed a bug where subscriptions and queries over websocket would not work. This was a regression introduced with 3.2.0.

# 3.2.0

### Enhancements
* Added a configuration option to include the objects matching the query in the collection response. It is not
`true` by default because it changes the response type slightly, which would break existing clients. It can be
enabled by passing `includeCountInResponses: true` in the `GraphQLService` constructor.
* Lifted the requirement to url-encode Realm paths.

# 3.1.0

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
