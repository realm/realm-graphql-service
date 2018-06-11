# NEXT RELEASE

### Enhancements

### Bug fixes

### Breaking Changes

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
