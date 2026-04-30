---
name: bruno
description: |
  Expert in Bruno, the Git-first, offline-only API client. Create and manage API
  collections using YAML-based OpenCollection format, write tests with assertions
  and Chai.js, implement request scripting and chaining, and run collections via CLI.
---

# Bruno API Client Skill

## Overview

Bruno stores API collections as plain text YAML files in your filesystem—version controlled, reviewable, and collaborative via Git. No cloud sync, no proprietary formats.

**Core Philosophy:**
- **Git-First**: Collections live alongside code, reviewed in PRs
- **Offline-Only**: No cloud dependency, everything local
- **YAML Format**: Human-readable OpenCollection specification
- **File-Based**: No databases, direct filesystem storage

---

## File Structure

```
My Collection/
├── opencollection.yml      # REQUIRED: Collection root with version header
├── collection.yml          # Optional: Collection-level settings
├── environments/
│   ├── Development.yml     # Environment variables
│   ├── Staging.yml
│   └── Production.yml
├── auth/
│   ├── folder.yml          # Optional: Folder-level settings
│   ├── Login.yml           # Individual request files
│   └── Refresh Token.yml
└── users/
    ├── folder.yml
    ├── Get Users.yml
    ├── Create User.yml
    └── Update User.yml
```

**Critical Rules:**
- Every collection MUST have `opencollection.yml` with `opencollection: 1.0.0` header
- Request files use `.yml` extension (NOT `.yaml`)
- Environments go in `environments/` directory
- Request-specific HTTP config NEVER goes in `opencollection.yml`

---

## File Formats

### opencollection.yml (Required)

```yaml
opencollection: 1.0.0

info:
  name: My API Collection

# Optional collection-level settings
config:
  proxy:
    inherit: true

request:
  variables:
    - name: sharedToken
      value: default-token
  scripts:
    - type: before-request
      code: console.log('Collection pre-request')

docs:
  content: |
    ### API Documentation
  type: text/markdown
```

**IMPORTANT**: `opencollection.yml` supports `info:`, `config:`, `request:` (variables/scripts), and `docs:` only. NEVER add `http:` (method/url/body) here—those belong in individual request `.yml` files.

### Request Files (*.yml)

Structure with top-level sections: `info:`, `http:`, `runtime:`, `settings:`, `docs:`

```yaml
info:
  name: Create User
  type: http
  seq: 1

http:
  method: POST
  url: "{{baseUrl}}/api/users"
  headers:
    - name: content-type
      value: application/json
    - name: authorization
      value: "Bearer {{authToken}}"
  body:
    type: json
    data: |-
      {
        "name": "{{userName}}",
        "email": "{{userEmail}}"
      }
  auth:
    type: bearer
    token: "{{authToken}}"

runtime:
  scripts:
    - type: before-request
      code: |-
        const timestamp = Date.now();
        bru.setVar("requestTimestamp", timestamp);
    - type: after-response
      code: |-
        if (res.status === 201) {
          bru.setVar("newUserId", res.body.id);
        }
    - type: tests
      code: |-
        test("User created successfully", function() {
          expect(res.status).to.equal(201);
          expect(res.body).to.have.property("id");
        });

settings:
  encodeUrl: true
```

### Environment Files (environments/*.yml)

```yaml
variables:
  - name: baseUrl
    value: https://api.example.com
  - name: apiVersion
    value: v1
  - name: apiKey
    value: ""
    secret: true  # Never committed to Git
  - name: authToken
    value: ""
    secret: true
```

### Folder Files (folder.yml)

```yaml
info:
  name: User Management
  type: folder

http:
  headers:
    - name: x-api-version
      value: "v2"
  auth:
    type: bearer
    token: "{{token}}"

runtime:
  scripts:
    - type: before-request
      code: bru.setVar("folderTimestamp", Date.now());
```

---

## JavaScript API Reference

### Request Object (req)

Available in `before-request` scripts:

```javascript
// URL and method
req.getUrl()                          // Get current URL
req.setUrl(url)                       // Set URL
req.getMethod()                       // Get HTTP method
req.setMethod('POST')                 // Set method (GET, POST, PUT, DELETE, PATCH)

// Headers
req.getHeader('content-type')         // Get specific header
req.getHeaders()                      // Get all headers as object
req.setHeader('x-api-key', 'value')   // Set single header
req.setHeaders({ key: 'value' })      // Set multiple headers

// Body
req.getBody()                         // Get request body
req.setBody(JSON.stringify(data))      // Set request body

// Configuration
req.setTimeout(5000)                  // Timeout in milliseconds
req.setMaxRedirects(5)                // Max redirect follows
```

### Response Object (res)

Available in `after-response` and `tests` scripts:

```javascript
// Properties
res.status                            // HTTP status code (200, 404, etc.)
res.statusText                        // Status text ("OK", "Not Found")
res.headers                           // Response headers object
res.body                              // Parsed response body (JSON auto-parsed)
res.responseTime                      // Response time in milliseconds

// Methods
res.getStatus()                       // Get status code
res.getHeader('content-type')         // Get specific header
res.getHeaders()                      // Get all headers
res.getBody()                         // Get raw response body
```

### Bruno Runtime (bru)

Available in all scripts:

```javascript
// Runtime variables (request-scoped, persists across requests in runner)
bru.setVar('key', 'value')
bru.getVar('key')

// Environment variables (stored in active environment file)
bru.setEnvVar('key', 'value')
bru.getEnvVar('key')
bru.setEnvVar('key', null)            // Delete environment variable

// Global environment variables (shared across all environments)
bru.setGlobalEnvVar('key', 'value')
bru.getGlobalEnvVar('key')

// Process environment (CI/CD, system env vars)
bru.getProcessEnv('API_KEY')

// Request chaining
bru.setNextRequest('Request Name')    // Chain to specific request
bru.setNextRequest(null)              // Stop chain

// Utilities
bru.sleep(1000)                       // Pause execution (ms)
bru.cwd()                             // Get current working directory
bru.interpolate('{{variableName}}')   // Interpolate variables

// Runner control
bru.runner.skipRequest()              // Skip current request
```

### Cookie Management

```javascript
const jar = bru.cookies.jar();

// Set cookie
jar.setCookie('https://api.example.com', 'sessionId', 'abc123');

// Set cookie with options
jar.setCookie('https://api.example.com', {
  key: 'authToken',
  value: 'xyz789',
  domain: 'example.com',
  path: '/api',
  secure: true,
  httpOnly: true,
  maxAge: 3600
});

// Get cookies
const cookie = await jar.getCookie('https://api.example.com', 'sessionId');
const allCookies = await jar.getCookies('https://api.example.com');

// Delete cookies
jar.deleteCookie('https://api.example.com', 'sessionId');
jar.deleteCookies('https://api.example.com');
jar.clear();                          // Clear all cookies
```

### Dynamic Variables

Use in URLs, headers, body:

```
{{$guid}}              // Random GUID/UUID
{{$timestamp}}           // Unix timestamp
{{$isoTimestamp}}        // ISO 8601 timestamp
{{$randomInt}}           // Random integer (0-1000)
{{$randomUUID}}          // UUID v4

// Identity
{{$randomEmail}}         // Random email
{{$randomFirstName}}     // Random first name
{{$randomLastName}}      // Random last name
{{$randomFullName}}      // Random full name
{{$randomPhoneNumber}}   // Random phone

// Location
{{$randomCity}}          // Random city
{{$randomCountry}}       // Random country
{{$randomStreetAddress}} // Random address

// Business
{{$randomJobTitle}}      // Random job title
{{$randomCompanyName}}   // Random company
```

Usage in scripts:
```javascript
const email = bru.interpolate('{{$randomEmail}}');
bru.setVar('userEmail', email);
```

---

## Authentication Patterns

### Bearer Token

```yaml
http:
  auth:
    type: bearer
    token: "{{authToken}}"
```

### Basic Auth

```yaml
http:
  auth:
    type: basic
    username: "{{username}}"
    password: "{{password}}"
```

### API Key

```yaml
http:
  auth:
    type: apikey
    key: x-api-key
    value: "{{apiKey}}"
    placement: header  # or "query"
```

### OAuth2

```yaml
http:
  auth:
    type: oauth2
    grant_type: authorization_code
    callback_url: http://localhost:8080/callback
    authorization_url: https://provider.com/oauth/authorize
    access_token_url: https://provider.com/oauth/token
    client_id: "{{clientId}}"
    client_secret: "{{clientSecret}}"
    scope: "read write"
```

### Auth Flow Example (Login → Use Token)

**auth/Login.yml:**
```yaml
info:
  name: Login
  type: http
  seq: 1

http:
  method: POST
  url: "{{baseUrl}}/auth/login"
  body:
    type: json
    data: |-
      {
        "username": "{{username}}",
        "password": "{{password}}"
      }
  auth:
    type: none

runtime:
  scripts:
    - type: after-response
      code: |-
        if (res.status === 200) {
          bru.setEnvVar("authToken", res.body.token);
          bru.setNextRequest("Get User Profile");
        }
    - type: tests
      code: |-
        test("Login successful", function() {
          expect(res.status).to.equal(200);
          expect(res.body).to.have.property("token");
        });
```

**auth/Get User Profile.yml:**
```yaml
info:
  name: Get User Profile
  type: http
  seq: 2

http:
  method: GET
  url: "{{baseUrl}}/api/users/me"
  auth:
    type: bearer
    token: "{{authToken}}"

runtime:
  scripts:
    - type: tests
      code: |-
        test("Profile retrieved", function() {
          expect(res.status).to.equal(200);
          expect(res.body).to.have.property("id");
          expect(res.body).to.have.property("email");
        });
```

---

## Testing Patterns

### Script Execution Order

1. Collection `before-request`
2. Folder `before-request`
3. Request `before-request`
4. **HTTP Request Executed**
5. Request `after-response`
6. Folder `after-response`
7. Collection `after-response`
8. Request `tests`
9. Folder `tests`
10. Collection `tests`

### Declarative Assertions (Simple)

Use for straightforward validations without JavaScript:

```yaml
runtime:
  assertions:
    - expression: res.status
      operator: eq
      value: "200"
    - expression: res.body.success
      operator: eq
      value: "true"
    - expression: res.body.data
      operator: isJson
    - expression: res.body.id
      operator: isNumber
    - expression: res.headers.content-type
      operator: contains
      value: "application/json"
    - expression: res.body.email
      operator: contains
      value: "@example.com"
    - expression: res.responseTime
      operator: lt
      value: "2000"
```

**Operators:** `eq`, `neq`, `lt`, `lte`, `gt`, `gte`, `contains`, `startsWith`, `endsWith`, `isNumber`, `isString`, `isBoolean`, `isJson`, `isArray`, `isEmpty`, `isNull`, `isUndefined`, `isTrue`, `isFalse`

### Chai.js Tests (Complex)

Use for complex logic, loops, custom validation:

```yaml
runtime:
  scripts:
    - type: tests
      code: |-
        test("Status is 200", function() {
          expect(res.status).to.equal(200);
        });

        test("Response has required fields", function() {
          expect(res.body).to.be.an("object");
          expect(res.body).to.have.property("id");
          expect(res.body).to.have.property("name");
          expect(res.body).to.have.property("email");
        });

        test("Email format is valid", function() {
          expect(res.body.email).to.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
        });

        test("Array contains items", function() {
          expect(res.body.items).to.be.an("array");
          expect(res.body.items).to.have.lengthOf.at.least(1);
        });

        test("Response time acceptable", function() {
          expect(res.responseTime).to.be.below(2000);
        });

        test("Nested data validation", function() {
          expect(res.body.user.profile).to.have.nested.property("settings.theme");
        });
```

**Chai.js Methods:**
- `expect(value).to.equal(expected)` - Strict equality
- `expect(value).to.deep.equal(expected)` - Deep equality
- `expect(value).to.be.a("type")` - Type check (string, number, object, array)
- `expect(value).to.have.property("key")` - Property existence
- `expect(value).to.have.nested.property("a.b.c")` - Nested property
- `expect(array).to.have.lengthOf(n)` - Array length
- `expect(array).to.include(item)` - Array contains
- `expect(string).to.match(/regex/)` - Regex match
- `expect(number).to.be.above(n)` - Greater than
- `expect(number).to.be.below(n)` - Less than
- `expect(value).to.be.null`, `to.be.undefined`, `to.be.true`, `to.be.false` - Boolean/null checks

---

## Variable Scopes (Precedence Order)

1. **Runtime variables** - `bru.setVar()` (highest priority)
2. **Request variables** - Set in request `variables:` block
3. **Folder variables** - From `folder.yml`
4. **Collection variables** - From `collection.yml`
5. **Environment variables** - From `environments/*.yml`
6. **Global environment variables** - Shared across environments
7. **Process environment variables** - `process.env.*` (lowest priority)

---

## CLI Commands

### Run Collections

```bash
# Run with specific environment
bru run --env Production

# Run specific folder
bru run --env Production --folder "User Management"

# Run specific request (by name)
bru run --env Production "Get User"

# Run recursively through all folders
bru run --env Production --recursive

# Run tests only
bru run --env Production --tests

# Fail fast on first failure
bru run --env Production --bail
```

### Output Options

```bash
# HTML report
bru run --env Production --reporter-html results.html

# JSON report
bru run --env Production --reporter-json results.json

# JUnit XML (for CI/CD)
bru run --env Production --reporter-junit results.xml

# Custom output directory
bru run --env Production --output ./test-results
```

### Other Commands

```bash
# List available environments
bru --version

# Run with sandbox (safer script execution)
bru run --env Production --sandbox

# Run with custom collection path
bru run --collection ./path/to/collection --env Production
```

---

## Examples

### CRUD Operations

**users/Get Users.yml:**
```yaml
info:
  name: Get Users
  type: http
  seq: 1

http:
  method: GET
  url: "{{baseUrl}}/api/users"
  params:
    query:
      - name: page
        value: "1"
      - name: limit
        value: "10"
  auth:
    type: bearer
    token: "{{authToken}}"

runtime:
  scripts:
    - type: tests
      code: |-
        test("Returns user list", function() {
          expect(res.status).to.equal(200);
          expect(res.body).to.be.an("array");
        });
```

**users/Create User.yml:**
```yaml
info:
  name: Create User
  type: http
  seq: 2

http:
  method: POST
  url: "{{baseUrl}}/api/users"
  headers:
    - name: content-type
      value: application/json
  body:
    type: json
    data: |-
      {
        "name": "{{$randomFullName}}",
        "email": "{{$randomEmail}}",
        "role": "user"
      }
  auth:
    type: bearer
    token: "{{authToken}}"

runtime:
  scripts:
    - type: before-request
      code: |-
        const email = bru.interpolate('{{$randomEmail}}');
        bru.setVar("createdEmail", email);
    - type: after-response
      code: |-
        if (res.status === 201) {
          bru.setVar("newUserId", res.body.id);
        }
    - type: tests
      code: |-
        test("User created", function() {
          expect(res.status).to.equal(201);
          expect(res.body).to.have.property("id");
          expect(res.body.email).to.equal(bru.getVar("createdEmail"));
        });
```

**users/Update User.yml:**
```yaml
info:
  name: Update User
  type: http
  seq: 3

http:
  method: PUT
  url: "{{baseUrl}}/api/users/{{userId}}"
  body:
    type: json
    data: |-
      {
        "name": "Updated Name"
      }
  auth:
    type: bearer
    token: "{{authToken}}"

runtime:
  scripts:
    - type: before-request
      code: |-
        if (!bru.getVar("userId")) {
          throw new Error("userId variable is required");
        }
    - type: tests
      code: |-
        test("User updated", function() {
          expect(res.status).to.be.oneOf([200, 204]);
        });
```

**users/Delete User.yml:**
```yaml
info:
  name: Delete User
  type: http
  seq: 4

http:
  method: DELETE
  url: "{{baseUrl}}/api/users/{{userId}}"
  auth:
    type: bearer
    token: "{{authToken}}"

runtime:
  scripts:
    - type: tests
      code: |-
        test("User deleted", function() {
          expect(res.status).to.be.oneOf([200, 204]);
        });
```

### Request Chaining Example

**e2e/Create Order Flow.yml:**
```yaml
info:
  name: Create Order Flow
  type: http
  seq: 1

http:
  method: POST
  url: "{{baseUrl}}/api/orders"
  body:
    type: json
    data: |-
      {
        "items": [{"productId": "123", "qty": 2}]
      }
  auth:
    type: bearer
    token: "{{authToken}}"

runtime:
  scripts:
    - type: after-response
      code: |-
        if (res.status === 201) {
          bru.setVar("orderId", res.body.id);
          bru.setVar("orderTotal", res.body.total);
          bru.setNextRequest("Process Payment");
        } else {
          bru.setNextRequest(null);
        }
```

**e2e/Process Payment.yml:**
```yaml
info:
  name: Process Payment
  type: http
  seq: 2

http:
  method: POST
  url: "{{baseUrl}}/api/payments"
  body:
    type: json
    data: |-
      {
        "orderId": "{{orderId}}",
        "amount": {{orderTotal}}
      }
  auth:
    type: bearer
    token: "{{authToken}}"

runtime:
  scripts:
    - type: after-response
      code: |-
        if (res.status === 200 && res.body.status === "completed") {
          bru.setNextRequest("Send Confirmation Email");
        } else {
          bru.setNextRequest("Handle Payment Failure");
        }
```

**e2e/Send Confirmation Email.yml:**
```yaml
info:
  name: Send Confirmation Email
  type: http
  seq: 3

http:
  method: POST
  url: "{{baseUrl}}/api/notifications/email"
  body:
    type: json
    data: |-
      {
        "orderId": "{{orderId}}",
        "template": "order_confirmation"
      }
  auth:
    type: bearer
    token: "{{authToken}}"

runtime:
  scripts:
    - type: tests
      code: |-
        test("Confirmation sent", function() {
          expect(res.status).to.equal(200);
        });
```

### Conditional Logic

```yaml
runtime:
  scripts:
    - type: after-response
      code: |-
        // Skip based on environment
        const env = bru.getEnvVar("environment");
        if (env === "production") {
          bru.runner.skipRequest();
          return;
        }

        // Conditional chaining
        if (res.status === 200 && res.body.requiresVerification) {
          bru.setNextRequest("Send Verification Code");
        } else if (res.status === 200) {
          bru.setNextRequest("Complete Registration");
        } else {
          bru.setNextRequest(null); // Stop chain
        }
```

### Data-Driven Testing

```yaml
runtime:
  scripts:
    - type: before-request
      code: |-
        // Generate dynamic test data
        const testData = {
          email: bru.interpolate('{{$randomEmail}}'),
          name: bru.interpolate('{{$randomFullName}}'),
          phone: bru.interpolate('{{$randomPhoneNumber}}'),
          company: bru.interpolate('{{$randomCompanyName}}')
        };
        req.setBody(JSON.stringify(testData));
        bru.setVar("testEmail", testData.email);
    - type: after-response
      code: |-
        // Validate and store for subsequent requests
        if (res.status === 201) {
          bru.setVar("createdUserId", res.body.id);
          bru.setEnvVar("lastCreatedEmail", bru.getVar("testEmail"));
        }
    - type: tests
      code: |-
        test("Data validation", function() {
          expect(res.body.email).to.equal(bru.getVar("testEmail"));
          expect(res.body.createdAt).to.be.a("string");
          expect(new Date(res.body.createdAt)).to.be.a("date");
        });
```

### GraphQL Request

```yaml
info:
  name: Get User Data
  type: http
  seq: 1

http:
  method: POST
  url: "{{baseUrl}}/graphql"
  body:
    type: graphql
    data: |-
      query GetUser($id: ID!) {
        user(id: $id) {
          id
          name
          email
          posts {
            title
            publishedAt
          }
        }
      }
    variables: |-
      {
        "id": "{{userId}}"
      }
  auth:
    type: bearer
    token: "{{authToken}}"
```

### WebSocket Request

```yaml
info:
  name: WebSocket Connection
  type: ws
  seq: 1

ws:
  url: "ws://localhost:8081/ws"
  headers:
    - name: Authorization
      value: "Bearer {{token}}"
  auth: inherit
```

---

## Best Practices

### File Organization
1. Use descriptive names: `Get User by ID.yml`, not `request1.yml`
2. Organize by feature/resource: `auth/`, `users/`, `orders/`
3. Use `folder.yml` for shared folder-level settings
4. Keep environments consistent across team

### Variable Management
1. **Environment variables** for per-env values (URLs, API keys)
2. **Runtime variables** for temporary data during execution
3. **Secrets** use `secret: true` in environment files (never commit)
4. Use `{{$randomEmail}}` etc. for test data generation

### Testing Strategy
1. Use `assertions` for simple checks, `tests` for complex logic
2. Test at collection, folder, and request levels
3. Validate status codes, headers, response structure, data
4. Extract and reuse response data for chaining

### Security
1. Never hardcode secrets in `.yml` files
2. Use `secret: true` for sensitive environment variables
3. Reference CI/CD secrets via `bru.getProcessEnv()`
4. Add `.gitignore` to exclude sensitive files

### Git Workflow
1. Commit collection changes alongside code changes
2. Review API changes in pull requests
3. Use branches for experimental API modifications
4. Tag releases to track API versions

---

## Common Mistakes

❌ **Missing `opencollection.yml`** - Every collection MUST have one  
❌ **Using `meta:` instead of `info:`** - Use `info:` for request metadata  
❌ **Putting `http:` blocks in `opencollection.yml`** - Request details go in separate `.yml` files  
❌ **Using `test` instead of `tests`** for script type  
❌ **Putting tests at root level** - They belong under `runtime: scripts:`  
❌ **Using `.yaml` extension** - Bruno uses `.yml`  
❌ **Hardcoded secrets** - Use variables with `secret: true`  
❌ **Missing `seq:` in request info** - Required for ordering

---

## Resources

- **Official Docs:** https://docs.usebruno.com/
- **OpenCollection Spec:** https://spec.opencollection.com/
- **Bruno CLI:** https://docs.usebruno.com/bru-cli/overview
- **AI Assistant Prompts:** https://github.com/bruno-collections/ai-assistant-prompts
