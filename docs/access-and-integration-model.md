# Access control & app integration model

This is the contract for how people and connected apps (the #8 IoT CRM, Billing, Ticketing, the Installation App, SIM, Asset, and third-party CRM, ERP and billing systems) get access to device data, and how that access stays **granular and consistent across every app**.

Status: design. Today the API isolates tenants, audits by actor and has a stub permission check for bulk ops. Everything below is new work.

## 1. Principles
1. **One identity, many apps.** #8 Identity (OIDC) gives single sign-on across all #8 products. Third-party apps connect through OAuth 2.0. Nobody shares API keys.
2. **Device Cloud is the source of truth for device data and device permissions.** The CRM is the source of truth for customers, accounts and contracts, and Billing for plans, invoices and entitlements. Each app owns its domain, and the others reference it by ID.
3. **Effective access is the intersection** of four things: *user permission ∩ app scope ∩ resource boundary ∩ plan entitlement*. An app can never do more than the user who authorised it, or more than the admin granted it.
4. **Deny by default, explain every denial.** The UI shows *why* something is not allowed and who can grant it.
5. **Everything is audited**, with actor, app, scope and resource.

## 2. Who can do what (users)
Access is **RBAC for verbs plus ABAC for boundaries**, so it is granular without needing hundreds of roles.

- **Permissions** are `resource:action`:
  - `devices:read`
  - `devices:write`
  - `devices:command`
  - `devices:lifecycle`
  - `ota:approve`
  - `config:apply`
  - `codecs:publish`
  - `billing:read`
  - `integrations:manage`
  - `members:manage`
  - `audit:read`
- **Field-level sensitivity**: `pii` (customer name, phone, location history), `credentials`, `commercial` (prices, deals). Each one needs an explicit permission, for example `devices:read:location`.
- **Roles** bundle permissions:
  - Owner
  - Admin
  - Fleet operator
  - Field installer
  - Support agent
  - Finance
  - OEM engineer
  - Developer
  - Viewer
  - Custom roles
- **Boundaries** limit *which* resources:
  - organisation
  - branch or region
  - customer account (from the CRM)
  - asset group
  - device tags
  - model or OEM

  Example: "Fleet operator, Chennai + Bengaluru branches, customer accounts A and B".
- **Conditions**: time window (shift hours), MFA required for critical actions (OTA approve, bulk suspend), and approval chains (two-person rule for OTA beyond canary).
- **Policy check**: `can(subject, action, resource, context) → {allow, reason, requires?}`. It is evaluated in the API for every request and every bulk-operation row, and mirrored in the UI so buttons can explain themselves.

## 3. How a connected app gets access
### 3.1 Installing an app (from the Ecosystem → Apps marketplace)
1. **The app declares a manifest:**
   - scopes;
   - events it subscribes to;
   - commands it may send;
   - data it writes back;
   - **mapping slots** (e.g. CRM Account ↔ Device Cloud customer);
   - UI extensions (a panel in Device 360, a column in the Fleet table).
2. **An admin installs it.**
   - A consent screen lists each scope in plain words, plus the field sensitivity involved.
   - The admin may **narrow** the grant: only branches X and Y, location excluded, read-only.
3. **Credentials are issued.**
   - #8 products get OAuth client credentials.
   - Third-party apps get OAuth authorization-code with PKCE, or a scoped token.
   - Webhooks get an HMAC signing secret.
   - Tokens are short-lived and refresh automatically.
4. **Mapping.**
   - The Integration Builder agent proposes field and identity mappings, such as CRM Account ↔ customer, CRM Contact ↔ user, and Billing Plan ↔ entitlement.
   - A human confirms them.
5. **Sync.** An initial backfill runs, then live events take over.

### 3.2 At runtime
- **App → Device Cloud** (API calls): the token carries `app`, `grant`, and optionally `onBehalfOf: user`. The policy check uses the **intersection** of the grant and the user's permissions.

  A CRM agent viewing a customer sees only that customer's devices, and only the fields both they *and* the CRM app are allowed.
- **Device Cloud → App** (events/webhooks): events are **filtered by the grant before delivery**. An app scoped to Chennai never receives Pune events, and payloads have restricted fields stripped.
- **Embedded UI**: when a Device Cloud panel is embedded in the CRM (or a CRM panel in Device 360), the panel runs under the *viewer's* identity through SSO, so the same policy applies. No privileged service account leaks data.

### 3.3 Mapping access between apps (the "granular CRM" case)
CRMs have their own granular model: teams, territories, account ownership and field-level security. We **don't copy CRM roles**. Instead we map their *boundaries* onto ours:

| CRM concept | Device Cloud boundary |
|---|---|
| Territory / region | branch / region |
| Account owner / team | customer-account boundary |
| Field-level security on PII | field sensitivity `pii` |
| Profile / permission set | role (mapped by admin, with a suggested mapping) |

Mappings sync on a schedule and on webhook. When a salesperson loses an account in the CRM, they lose its devices in Device Cloud within minutes. Changes appear in the audit log.

## 4. How Billing works (entitlements and metering)
- **Billing → Device Cloud: entitlements.** A plan defines:
  - device quota;
  - message quota;
  - features (OTA, AI agents, advanced reports, number of apps);
  - retention;
  - support tier.

  Device Cloud enforces these as a fourth layer in the policy check, and the UI shows upgrade prompts instead of errors.
- **Device Cloud → Billing: usage meters.** These are idempotent, signed usage events:
  - active devices per day;
  - messages decoded;
  - OTA deployments;
  - SIM data (from SIM Management);
  - commands;
  - plugin downloads;
  - API calls.

  Billing rates them per plan or contract.
- **Lifecycle-driven billing.** A device's billing state follows its lifecycle: billing starts at *activated*, pauses at *suspended*, and stops at *retired*. A swap moves the subscription to the new device.
- **Customer-level invoicing.** Usage is tagged with the CRM account. Billing can invoice each end customer, and resellers get their own invoices.

## 5. How other apps adapt (one pattern for all)
Every app integration is a **connector** with the same parts. A new app only needs a manifest and a mapping, with no core changes:

| Part | Example: Ticketing | Example: Installation App | Example: SAP/ERP |
|---|---|---|---|
| Events in | `alert.opened`, `device.offline` → ticket | `device.assigned` → job | `device.activated` → asset record |
| Writes back | ticket status → alert ack/resolve | job done → lifecycle `pending_activation` | asset number → device tag |
| Scopes | `alerts:read/write`, `devices:read` | `devices:lifecycle`, `assets:write` | `devices:read`, `assets:read` |
| Boundary | support team's regions | the installer's own jobs only | organisation |
| UI extension | ticket panel in Device 360 | job checklist on phone | asset link on device |

Delivery uses the canonical event bus (`decoded.v1`, `device.*`, `alert.*`, `ota.*`, `billing.usage.*`), with retries, a dead-letter queue (DLQ), replay and per-app health shown on the Integrations page.

## 6. What it looks like in the console
- **Admin → Members & roles**: role builder, boundary picker (branches, accounts, tags), and an "Access preview" that shows what this person can see and why.
- **Admin → Access policies**: MFA and approval rules for critical actions.
- **Ecosystem → Apps → Install**: consent screen with scopes, a narrowing control, a mapping step (agent-suggested) and a test connection.
- **Developer → Connected apps**: per-app grant, token health, event delivery stats, DLQ replay, and revoke.
- **Every disabled button** explains itself: "Needs `ota:approve` · ask Priya (Admin)".
- **Admin → Audit**: filter by user, app, scope or resource.
