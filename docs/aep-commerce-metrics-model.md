# AEP: commerce, metrics & KPIs, and user-driven adaptation

#8 runs an **Application Enablement Platform (AEP)**. Device Cloud is not a fixed app. Each participant can shape it to *their* purpose:
- **user-driven**: their own metrics, views, fields and workflows;
- **operations-driven**: playbooks and automations act on those metrics;
- **outcome-driven**: KPIs roll up into goals that sit on their home screen.

This document is the contract. It builds on `ecosystem-model.md` (participants, listings, deals) and `access-and-integration-model.md` (scopes, grants, entitlements, metering).

## 1. Commerce: sell products and services from Device Cloud

### 1.1 Anyone can be a seller
Any participant with the `commerce:sell` permission can publish **Offerings**.

| Offering type | Examples | Typical pricing |
|---|---|---|
| **Device** | GT200 tracker, EM3 meter | unit price, volume tiers, MOQ, lead time |
| **Bundle / solution** | "Cold-chain kit": sensor + gateway + SIM + app + install | one-time + per-device/month |
| **Service** | installation, commissioning, AMC/maintenance, calibration, SIM provisioning, custom firmware | per job, per visit, per device/year, SLA tiers |
| **Subscription** | monitoring plan, data plan, extended warranty, premium support | per device/month, usage-based (messages, GB) |
| **App / plugin** | analytics app, decoder plugin pack, integration connector | per tenant/month, per seat, free |
| **Data product** | anonymised field insights, benchmark reports | per report / per month |

`Offering { id, sellerId, type, title, media, description, specs, pricing: PriceModel[], regions, fulfilment, sla?, linkedModelIds?, linkedAppId?, status: draft|review|live|paused, visibility: public|partners|invite }`

`PriceModel` supports `one_time | recurring(interval) | usage(meter, unitPrice, tiers) | quote_only`, in INR and other currencies, with tax hints (GST).

### 1.2 The buying flow (in-app, not just a brochure)
1. Discover in Ecosystem → Marketplace (devices, apps, services, bundles).
2. Add to cart, or request a quote. The quote negotiation is a **Deal** (inquiry → quoted → sampled → ordered → delivered).
3. Checkout:
   - **#8 Billing** creates the order and the invoice or subscription;
   - a payment gateway (Razorpay, Stripe and others) is reached through Billing;
   - net terms are available for enterprise buyers.
4. **Fulfilment is wired into operations.** That is what makes this different from a store:
   - **Device order:** serials are shipped, then a batch is created in the buyer's Fleet. Devices arrive *registered* with their decoder already adopted.
   - **Installation service:** a job is created in the Installation App. Its completion moves the device lifecycle forward.
   - **Subscription or app:** entitlements are granted and the app is installed with the consented scopes.
5. After the sale: reviews, renewals, upsell signals (for example, "fleet at 92% of plan quota"), and support tickets.

### 1.3 Integrating external marketplaces and storefronts
- **Syndication out:** publish offerings to the seller's own website through an embeddable storefront widget and API, and to external channels (B2B marketplaces, cloud marketplaces, distributor portals) through channel connectors.
- **Orders in:** orders from external channels arrive as Deals or Orders through the same connector, so fulfilment is identical.
- **Catalog sync:** price and stock changes flow both ways and are audited.
- Each channel is a connector with a manifest, as in `access-and-integration-model.md` §5.

### 1.4 Seller console
- Offerings manager.
- Orders and deals pipeline.
- Fulfilment queue.
- Revenue and payouts (from Billing).
- Reviews.
- Channel connections.
- Seller KPIs: leads, conversion, average order value (AOV), attach rate of services to devices, renewal rate, time to fulfil.

## 2. Metrics & KPIs: provided, and created by the user

### 2.1 Layers
```
Signals (raw)          decoded fields, device state, events, orders, tickets, usage
  └─ Metrics           a measure over signals: aggregation + filter + time grain + dimensions
       └─ KPIs         metric + target + direction + thresholds + owner + review cadence
            └─ Outcomes   a goal made of 1–5 KPIs, with blockers and playbooks (shown on Today)
```

### 2.2 Metric definition (a semantic metric layer)
`MetricDef { id, name, description, unit, source, measure, filters, dimensions[], grain, formula?, owner, visibility, version }`

- **source**:
  - `telemetry` (any decoded field of any model, e.g. `GT200.speed`, `EM3.kwh_import`);
  - `devices` (state and lifecycle);
  - `events`, `alerts`, `ota`, `commands`;
  - `commerce` (orders, deals, revenue);
  - `apps` (from connected apps: tickets, invoices, CRM opportunities);
  - `custom` (pushed through the API).
- **measure**: `count | distinct | sum | avg | min | max | p50 | p95 | rate | ratio | duration | last`.
- **formula**: for derived metrics, using the same **safe expression language** as automations (from ops-engine). It references other metrics, e.g. `revenue_ready_devices / activated_devices * 100`.
- **dimensions**: org, branch, region, model, OEM, firmware, customer account, asset group, tag, any decoded enum field.
- **grain**: minute, hour, day, week, month.
- Metrics are versioned. Editing a formula creates a new version, and history keeps its definition.

### 2.3 KPI definition
`KpiDef { id, metricId, name, target, direction: up|down|band, thresholds: {good, warn, bad}, comparison: previous_period|same_period_last_year|baseline, owner, reviewCadence, scope: Boundary, linkedPlaybookIds[], alert?: {when, notify, automationId} }`

- When a KPI is breached, a **Playbook** or **Automation** can run, or an action item appears in the Today queue. This closes the loop from metric to outcome to operation.

### 2.4 The library we provide (templates, cloneable)
| Domain | KPIs |
|---|---|
| Fleet | revenue-ready %, data freshness SLA, uptime %, MTTR, devices never seen, stale % |
| Lifecycle | install-to-activation days, stuck-in-stage count, swap rate, retire rate |
| Firmware/OTA | OTA success %, firmware adoption %, rollback rate, time to 90% adoption |
| Quality | decode success %, unknown payload rate, field failure rate, RMA rate |
| Connectivity | SIM data per device, roaming cost, signal quality, carrier failover |
| Commerce | leads, quote-to-order %, AOV, service attach rate, renewal %, time to fulfil |
| Ecosystem | decoder adoptions, app installs, partner certifications, listing views → leads |
| Vertical packs | Fleet telematics (idle %, harsh events/100 km, fuel/km); Energy (kWh, power factor, outage minutes); Cold chain (time out of range, excursions); Smart building (comfort %, occupancy) |

Each persona and solution template ships a default set of outcomes and KPIs. The user can then change targets, add KPIs, or build from scratch.

### 2.5 Builder UX
- **Metric builder**: pick a source → a field (with a live preview of the real decoded values) → measure → filters → dimensions. A formula editor has autocomplete and validation, and a **natural-language mode**: "average battery of GT200 in Chennai, daily". The Copilot drafts the definition, and the user confirms.
- **KPI builder**: target, direction, thresholds, and a sparkline backtest that shows how often the threshold would have breached in the last 30 days, plus an owner and a linked playbook.
- **Boards**: drag-and-drop dashboards from KPIs and metrics. They can be shared within boundaries and pinned to Today as Outcomes.
- **Governance**: certified vs personal metrics (like a semantic layer). Certified metrics are reviewed by an admin, and duplicates are detected.

## 3. AEP: how the application adapts
| Lever | What the user can do | Where |
|---|---|---|
| **Outcomes and KPIs** | Define what success means, by persona or team | Insights → Metrics, KPIs; Today |
| **Custom fields and objects** | Add fields to devices, assets and customers (e.g. "Vehicle permit no.") and define custom objects (e.g. "Route", "Cold room") | Admin → Data model |
| **Views** | Save filters, columns and layouts as named views; share them by boundary | Every table |
| **Workflows** | Automations and playbooks built from triggers, conditions and actions across apps | Operate |
| **Workspaces** | Reorder or hide navigation, set the home outcomes, and name things in the user's own terms | Admin → Workspace |
| **Extensions** | Connected apps add panels, columns, actions and ⌘K commands | Through the app manifest |
| **Solution templates** | Adopt a whole vertical setup in one step: models, apps, KPIs, playbooks, views | Ecosystem → Solutions |
| **API and SDK** | Everything above is also available as code (metrics-as-code, versioned in git) | Developer |

Entitlements from Billing decide which levers a plan unlocks.

## 4. Console additions
- **Ecosystem**: `/ecosystem/marketplace` lists all offerings (devices, services, bundles, apps), plus cart and checkout, and `/ecosystem/orders` lists purchases.
- **Sell**:
  - `/sell` (seller home and KPIs)
  - `/sell/offerings`, `/sell/offerings/new`, `/sell/offerings/[id]`
  - `/sell/orders`
  - `/sell/channels`
  - `/sell/payouts`
- **Insights**:
  - `/insights/metrics`, `/insights/metrics/new`
  - `/insights/kpis`, `/insights/kpis/new`
  - `/insights/boards`, `/insights/boards/[id]`
  - `/insights/library`
- **Admin**: `/admin/data-model` (custom fields and objects) and `/admin/workspace` (navigation, home and terminology).
