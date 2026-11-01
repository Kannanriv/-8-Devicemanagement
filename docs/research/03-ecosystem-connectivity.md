# 03 - Ecosystem, Marketplace and Connectivity Platforms

Scope: Tuya, Samsara, connectivity players (Hologram, 1NCE, Kore, Telit/Kigen, Soracom), Matter/CSA, AWS Partner Device Catalog, AppExchange, Shopify, ServiceNow. Evidence note: web search returned official pages for Tuya, Samsara, Hologram, Soracom, AWS and Salesforce. Shopify, CSA, Kore, Telit/Kigen and ServiceNow are from general knowledge and flagged "(unverified)". Pricing is marketing-level; confirm before citing.

## 1. Platform findings

### Tuya
- (a) Features: no-code branded OEM app ("10 minutes", "90% less dev cost" claims), hosted App Launch (push messaging), OEM App Update, certification support (module sent to designated lab, platform confirms), Works with Tuya badge once the device connects to Smart Life / Tuya Smart app; Matter app certification. https://developer.tuya.com/en/certification , https://tuya.com/platform/vas/works-with , https://www.tuya.com/vas
- (b) Flywheel: OEM builds on Tuya modules and gets white-label app + cloud + certification in one path; the shared Smart Life app and Works-with badge give cross-brand compatibility. Certification is a gate to the badge and compliance, not a lead source. An "App Mall" exists but listing mechanics are not public.
- (c) Love: speed to market, module breadth. Complain (unverified): cloud lock-in, privacy and local-control concerns (see Home Assistant community list https://community.home-assistant.io/t/tuya-based-app-list/985811 ), white-label apps all looking alike.
- (d) Money: tiered annual packages (marketing pages cite about $12k/yr Basic with OEM app, about $20k/yr Business) https://www.tuya.com/tuyaplus ; paid value-added services, module sales, cloud/messaging usage.

### Samsara
- (a) Features: App Marketplace with 200+ technology partners; open API; Technology Partner Program with application process and a referral track; Industrial Partner Program for OT/IoT vendors. https://developers.samsara.com/docs/technology-partner-program , https://www.samsara.com/blog/introducing-the-samsara-industrial-partner-program
- (b) Flywheel: partners integrate to reach Samsara's large fleet/ops installed base; Samsara gains "works with everything" stickiness; referral track enables co-sell. Application vetting is the quality gate.
- (c) Love: single pane of glass. Complain (unverified): hardware lock-in, contract rigidity.
- (d) Money: hardware plus per-asset SaaS subscription; no public marketplace rev share found. The marketplace is a retention lever, not a profit centre.

### Connectivity (Hologram, 1NCE, Kore, Telit/Kigen, Soracom)
- (a) Hologram: OTA eUICC profiles, IoT only; some SIM revisions cannot switch profiles. https://hologram.io/products/esim/ Soracom: SGP.32 "Connectivity Hypervisor" ships with a bootstrap profile, switches to a local/use-case profile, falls back to Soracom profile. https://www.businesswire.com/news/home/20250716825000/en/Soracom-Unveils-%E2%80%9CConnectivity-Hypervisor%E2%80%9D-to-Expand-Flexibility-and-Control-in-Global-IoT-Connectivity , https://www.automotiveworld.com/news/soracom-launches-sgp-32-esim-pre-orders-at-mwc/ 1NCE: flat-rate lifetime SIM (about $0.03/MB overage reported). Kore and Telit/Kigen: managed connectivity and eUICC OS (unverified).
- (b) Flywheel: SIMs are embedded in module/OEM BOMs, then earn recurring data revenue per device; integrations with AWS/Azure drive distribution.
- (c) Love: global coverage, API-first SIM ops, pooled data. Complain: opaque long-term pricing, negotiated discounts, non-transferable agreements (1NCE), profile-switch limits. https://www.rfp.wiki/it-security/managed-iot-connectivity-services/hologram/1nce (AI aggregator, low trust)
- (d) Money: per-SIM fee + data pools, overage, platform fee, eSIM profile fees.

### Matter / CSA and "Works with" (unverified; search returned nothing)
- (a) Certification via Authorized Test Labs, entry in the Distributed Compliance Ledger, logo rights; Works with Alexa/Google/Apple badges.
- (b) Certification is a prerequisite for shelf and ecosystem presence; badge lowers buyer risk, so it drives sales indirectly.
- (c) Love: interoperability. Complain: cost, long test cycles, feature gaps across controllers.
- (d) CSA membership tiers + per-product certification fees.

### AWS Partner Device Catalog / Qualified Devices
- (a) Self-service submission via APN Partner Central, evidence from AWS IoT Device Tester, listing with buy links. https://aws.amazon.com/blogs/apn/introducing-the-aws-device-qualification-program , https://aws.amazon.com/jp/partners/programs/dqp/
- (b) Hardware vendors gain discoverability among AWS builders; automated test evidence is the credential.
- (c) Love: objective, automated qualification. Complain (unverified): stale catalog, thin lead flow.
- (d) Free to list for APN partners; AWS monetises consumption.

### Salesforce AppExchange and Shopify (benchmark marketplaces)
- AppExchange: mandatory security review for managed packages (reported about $2,700 first year, $300 renewals; free apps exempt; weeks to months); ISVforce about 15% revenue share, OEM-embedded about 25%. https://developer.salesforce.com/docs/atlas.en-us.262.0.packagingGuide.meta/packagingGuide/security_review_create_secure_solution.htm , https://ceptes.com/blogs/salesforce-appexchange-pricing-the-definitive-guide/
- Flywheel: customers already inside the CRM browse a trusted store; reviews and mandatory scans signal quality; partner tiers drive co-marketing. Complaints: slow review, fee hikes, rev-share resentment https://www.pcworld.com/article/447103/salesforcecom-to-impose-massive-fee-hike-for-app-store-security-review.html
- Shopify (unverified): reduced rev share on early revenue, "Built for Shopify" quality badge boosting ranking, listing analytics, review-driven ranking, billing through the merchant's Shopify invoice. Best-in-class developer ROI.

### ServiceNow Field Service + OIOT (unverified)
- IoT alerts auto-create work orders, skills/geo scheduling, parts inventory, mobile technician app, SLAs, warranty/entitlement checks, customer portal. Flywheel is enterprise platform lock-in; complaints are cost and implementation heft.

## 2. Top 15 gaps for #8 (ranked)

1. **eSIM/eUICC profile switching and connectivity cost control** - SGP.32-aware profile management, pooled-data budgets per fleet, auto-switch on cost/coverage, bill-shock alerts, multi-carrier fallback. Why: connectivity is the largest recurring OPEX of a fleet. Persona: OEM, Solution company.
2. **OEM white-label mobile app** - brand-themed end-user app with QR pairing, push, sharing, OTA, generated from the Device Codec Spec. Why: Tuya's core hook; OEMs want the consumer relationship. Persona: OEM.
3. **App review and security vetting** - scope review, automated scanning, manual review, versioned approvals, "verified" badge. Why: trust drives installs (AppExchange). Persona: Solution company, platform owner.
4. **Sandbox/test tenants for app developers** - tenant with simulated devices from codecs, test keys, sample data, promotion path to review. Why: shortens integration time. Persona: ISV/Solution company.
5. **Revenue share and payouts** - configurable take rate by listing type and tier, invoicing, tax, settlement reports. Why: sellers need predictable economics; AppExchange 15-25% is the anchor. Persona: OEM, ISV, Distributor.
6. **Partner tiers with benefits** - automatic promotion from certified devices, deployed units, deal volume, CSAT; benefits = lower take rate, badges, MDF, lead priority. Why: gamifies the flywheel. Persona: OEM, Installer.
7. **Lead routing to distributors** - territory/product/capacity rules, SLA timers, re-route on breach, win/loss feedback. Why: turns catalog views into sales; Tuya and AWS lack it. Persona: OEM, Distributor.
8. **Listing analytics** - impressions, inquiries, conversion, search terms, region heatmap, benchmarks. Why: Shopify-style seller insight sustains investment. Persona: OEM, ISV.
9. **Field-service work order flow** - alert to work order, skill/geo dispatch, mobile checklist with photo and serial scan, parts, SLA, auto-close when telemetry recovers. Why: ServiceNow's wedge; monetises installation services. Persona: Installer.
10. **Warranty/RMA flow** - entitlement check from serial and install date, return authorization, swap, failure-reason capture feeding health score and OEM quality dashboards. Persona: OEM, Distributor, Solution company.
11. **Customer-facing portals** - branded end-customer portal (devices, invoices, tickets, SLA), embeddable widgets. Why: lets solution companies resell the platform. Persona: Solution company, Installer.
12. **Co-marketing program** - MDF requests, co-branded landing pages, featured slots earned by tier, case-study templates. Why: certification alone does not create demand. Persona: OEM, ISV.
13. **Device transfer and resale** - ownership transfer with credential re-key and data wipe, certified refurbished listings, trade-in credit. Why: lifecycle completeness, circular economy. Persona: OEM, Solution company.
14. **Sustainability and carbon reporting** - per-device embodied and use-phase carbon, energy rollups, ESG export, "eco" badge. Why: procurement RFPs increasingly require it. Persona: Solution company, OEM.
15. **"Works with #8" interoperability badge** - automated conformance tests reusing codec verification, cross-listing with Matter/AWS-qualified status, publicly verifiable certificate IDs. Why: AWS Device Tester and CSA ledger show objective, portable certification wins trust. Persona: OEM.

## 3. Anti-patterns to avoid
1. **Cloud lock-in with no local/export path** (Tuya complaints): ship open APIs, data export and MCP access.
2. **Slow, opaque review** (AppExchange): publish SLAs, automate first-pass scans, show queue status.
3. **Pay-to-play badges**: certification must be test-based and verifiable, not purchasable.
4. **Opaque or negotiated-only connectivity pricing**: show live cost per device and committed vs overage clearly.
5. **Marketplace without lead flow**: AWS-style catalogs with no inquiry routing go stale; every listing needs measurable leads, analytics and an owner SLA.
