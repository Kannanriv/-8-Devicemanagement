# #8 Device Ecosystem Model

This document is the contract for how every participant, product and flow in the #8 IoT ecosystem relates. It is implemented in:
- `packages/ecosystem`: logic;
- `apps/console/src/data/contract/ecosystem.ts`: UI contract;
- the API: later phase.

Device Management is one part of this ecosystem.

## 1. Participants (organisations)
Every organisation is a `Participant` with one or more **roles**. A company can be both an OEM and a solution provider, for example.

| Role | Does | Gets from #8 |
|---|---|---|
| **OEM** (device maker) | Designs devices, publishes specs and firmware | Launch Studio, certification, storefront, leads, field insights, OTA |
| **Module / chipset vendor** | Supplies radios, modules and reference firmware | Reference designs listed as building blocks for OEM models |
| **Distributor** | Stocks and resells devices in regions | Catalog syndication, quote routing, stock and price lists |
| **Solution provider** (system integrator) | Buys devices and builds vertical solutions (fleet, energy, cold chain) | Adopted decoders, fleet operations, app integrations |
| **Installer** (field services) | Installs, commissions and swaps devices | Installation jobs, activation checks, first-time-right score |
| **Connectivity provider** | SIM/eSIM, LoRaWAN networks, NB-IoT | Compatibility listing, SIM management link |
| **App developer / ISV** | Builds apps that consume device data (billing, CRM, analytics) | App Marketplace listing, data scopes, webhooks |
| **Customer** (end customer) | Owns the outcome (the vehicle tracked, the energy metered) | Customer apps, reports, SLA |
| **#8 Platform** | Operates the ecosystem | Certification authority, trust, billing of the ecosystem |

`Participant { id, name, roles[], tier: registered|verified|premier, regions[], verifiedAt, profile, metrics }`

## 2. Products in the ecosystem
- **DeviceModel**: an OEM's product. It has:
  - `oemId`, `category`, `connectivity[]`, `hardwareRevisions[]`;
  - lineage: built on module X, a variant of model Y.
- **FirmwareRelease**: belongs to a model; semver; signed; release notes.
- **CodecRelease**: belongs to a model and covers a firmware range. Its diff against the previous release says breaking or not. It **travels with the device**.
- **Certification**: belongs to a model and a codec release. It has:
  - a level, in order: `listed` < `codec_verified` < `ota_ready` < `secure` < `hash8_certified`;
  - steps, evidence, and an expiry date.
- **Listing**: the storefront page for a model. It has:
  - hero, gallery, specs, datasheet;
  - pricing tiers, MOQ, lead time, regions;
  - compatibility, certifications, docs, reviews.
- **App**: a Marketplace app.
  - It is a #8 product or third-party: SIM Management, Device Gateway, Asset Management, IoT CRM/Billing, Notifications & Ticketing, Installation App, Customer Apps, and third-party CRM, ERP, billing, BI and messaging.
  - It requests **data scopes**: e.g. `decoded:read`, `devices:read`, `events:subscribe`, `commands:write`.
  - It has setup steps and pricing.
- **Solution template**: a bundle of device models, apps, automations and dashboards for a vertical, e.g. "Cold-chain monitoring" or "Fleet telematics". A solution provider adopts it in one step.

## 3. Relationships (the graph)
```
Module vendor ──supplies──▶ DeviceModel ◀──makes── OEM
DeviceModel ──has──▶ FirmwareRelease ──decoded by──▶ CodecRelease
DeviceModel ──earns──▶ Certification ──displayed on──▶ Listing
Distributor ──resells──▶ Listing (by region)
Solution provider ──adopts──▶ CodecRelease  (Adoption: auto-upgrade non-breaking)
Solution provider ──buys──▶ Device (instances) ──installed by──▶ Installer ──for──▶ Customer
Device ──connected via──▶ Connectivity provider (SIM / network)
App ──installed by──▶ Solution provider / Customer ──consumes scopes──▶ Device data
Solution template ──bundles──▶ DeviceModels + Apps + Automations
```
Every edge is an `EcosystemRelation { from, to, kind, since, status, volume }`. That is what lets the console draw the **Ecosystem Map**, a graph you can filter by role, region and category. Edge weight is device count or message volume.

## 4. Flows (the value chain)
1. **Launch**: OEM creates a model → imports the spec (Excel) → the codec is verified → firmware is signed → certification → listing published.
2. **Discover**: a buyer browses the catalog, filtering by category, connectivity, certification and region. They try the **live decoder** and compare models.
3. **Transact**: the buyer sends a quote request or sample order. It goes to the OEM, or to a regional distributor. A **Deal** moves through `inquiry → quoted → sampled → ordered → delivered`.
4. **Adopt**: the buyer adopts the codec. Their tenant now decodes that model automatically and can download plugins in 6 languages.
5. **Deploy**: devices are onboarded (batch or CSV) → installer jobs → activation → first decoded message. **Ownership transfer** moves devices from OEM to buyer, and the codec access travels with them.
6. **Integrate**: install apps from the Marketplace, grant scopes, data flows (billing meters, CRM fields, tickets).
7. **Operate and improve**: field health and failure data flows back to the OEM as *anonymised field insights*. A new firmware release brings a new codec release. Subscribers are notified, and non-breaking releases auto-upgrade.

## 5. Economics
- **OEM:** listing plans and certification fees; it receives leads.
- **Distributor:** margin.
- **App developers:** a revenue share on paid apps.
- **Solution providers:** a per-device platform fee.

The console shows each participant **their** ecosystem outcomes:
- **OEM:** leads, conversion rate, devices activated, decoder adoptions, revenue influenced.
- **Distributor:** quotes and win rate.
- **App developer:** installs and active tenants.
- **Solution provider:** time-to-value per adopted model.

## 6. Trust
- Certification levels are earned by **automated evidence**: vectors pass in every plugin language, OTA dry run, security review, interop. Certification expires when a new firmware lands without re-certification.
- Participant tiers come from verification (KYC/business), performance and reviews.
- Apps ask for explicit scopes, and admins approve them. Every grant appears in the audit log.

## 7. Where it shows in the console (the Ecosystem workspace)
- **Ecosystem overview, `/ecosystem`**:
  - the persona's ecosystem outcomes;
  - the live **Ecosystem Map**;
  - activity: new listings, adoptions, deals, releases.
- **Devices catalog, `/ecosystem/devices`, `/ecosystem/devices/[id]`**: storefront, live decoder, compare, quote/sample/adopt.
- **Apps, `/ecosystem/apps`, `/ecosystem/apps/[id]`**: install wizard with scopes.
- **Solutions, `/ecosystem/solutions`**: vertical templates to adopt in one step.
- **Partners, `/ecosystem/partners`, `/ecosystem/partners/[id]`**: directory, partner profile, relations.
- **Deals, `/ecosystem/deals`**: the quote and sample pipeline. The OEM and distributor see it as sellers; buyers see it as purchases.
- **Releases and adoptions, `/ecosystem/releases`**: codec and firmware releases, diffs, subscribers, upgrade status.
- **Programs, `/ecosystem/programs`**: certification levels, partner tiers, benefits, and how to level up.
