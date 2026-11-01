# 02 - Device-centric and developer-first platforms

Method note: checked 2026-11-01 via web search. Vendor pricing pages often did not render, so figures marked (agg) come from aggregators and need verification. Feature and sentiment notes combine searched pages with prior product knowledge; unverified items are flagged "verify".

## Per-platform findings

**Particle** (https://www.particle.io, https://changelog.particle.io)
- (a) Integrated modules/dev kits, Device OS and cloud. Device OS 6.1 added device-side Ledger storage; Cloud Ledger syncs shared state between cloud and devices without custom topics. Logic runs serverless-style automations on events. Fleet OTA with groups, SIM management, event stream, webhooks.
- (b) Fastest zero-to-connected for cellular; SIM, hardware and cloud on one bill; good docs.
- (c) Lock-in to Particle hardware and Device OS; data-operation quotas surprise on bills; cost at scale.
- (d) Per-device plans plus data-operation quotas; free tier; Basic ~$299/mo, Plus ~$599/mo (agg: https://pricingsaas.com/companies/particle).

**Golioth** (https://golioth.io/pricing, https://blog.golioth.io/device-management-should-be-free/)
- (a) Zephyr/ESP/Nordic-first. Pipelines: declarative YAML routing of device data to destinations with transformers (CBOR to JSON, batching, filters). LightDB State/Stream, RPC, settings, OTA artifacts and cohorts, device logs.
- (b) Open SDKs, "device management should be free", transparent unit pricing, Zephyr community.
- (c) Younger ecosystem; thin dashboards/analytics; needs embedded skill.
- (d) From Apr 1 2026: $0.25 per connected device per active month, $0.0095/MB OTA, $0.0080/MB Pipelines data; free for individuals; Teams ~$299/mo (agg) (https://blog.golioth.io/?p=10548).

**Memfault** (https://memfault.com/pricing/)
- (a) Embedded observability SDK: coredump/crash capture, symbolication, dedup into Issues, reboot reasons, heartbeat metrics (battery, connectivity), release tracking, fleet health by software/hardware version, OTA with cohorts, staged rollout and abort on regression; Android and MCU.
- (b) Best-in-class crash triage; metric-linked releases.
- (c) Expensive for small teams; SDK integration effort; not a connectivity/data platform.
- (d) Growth from ~$3,495/mo, pay-as-you-go beyond 10 devices; Scale/Enterprise quote-based; 30-60 day retention by tier (https://www.capterra.com/p/214177/Memfault/).

**Balena** (https://www.balena.io/pricing)
- (a) Docker container fleets on Linux; balenaOS, multi-container, delta image updates, public device URLs, remote SSH/terminal, device logs, fleet/device variables, build-on-push.
- (b) Developer-friendly Linux fleet ops; remote SSH; first 10 devices free.
- (c) No MCU support; per-device costs rise; free tier cut in 2023 (https://blog.balena.io/pricing-update-2023/).
- (d) First 10 devices free; Prototype ~$159/mo (30 devices), Pilot ~$329/mo, volume tiers (agg: https://pricingsaas.com/companies/balena).

**Nordic nRF Cloud** (https://www.nordicsemi.com/Products/nRF-Cloud) - verify details
- (a) Tied to nRF91/nRF70/nRF52. Location services (cell/Wi-Fi/GNSS, A-GNSS, P-GPS), FOTA with delta DFU, shadows, certificate provisioning, Memfault integration.
- (b) Location-as-a-service for low-power devices; chip-integrated provisioning.
- (c) Nordic hardware only; thin dashboards.
- (d) Free tier plus per-message/per-location-request pricing.

**Blues Notecard / Notehub** (https://blues.com/pricing, https://dev.blues.io)
- (a) Prepaid cellular/LoRa/Wi-Fi module with bundled data; Notehub with JSON Notes over I2C/UART, Routes (HTTP, MQTT, AWS, Azure, Snowflake) with JSONata transforms, environment variables for fleet config, outboard DFU, location, Smart Fleets (query-based dynamic groups).
- (b) Predictable cost (data prepaid), very simple MCU integration, low power.
- (c) Proprietary module required; limited analytics.
- (d) Hardware plus prepaid data upfront; Notehub free for Notecard devices; enterprise add-ons.

**Losant** (https://www.losant.com/pricing)
- (a) Visual Workflow Engine, Experiences (white-label end-user portals with roles), dashboards, edge workflows, application templates.
- (b) Low-code builds apps quickly; end-user portals.
- (c) Payload/workflow limits and opaque tiers; dated UI (verify).
- (d) Tiered by application, devices and payloads; enterprise quote (verify).

**Datacake** (https://datacake.co/pricing)
- (a) No-code dashboards, LoRaWAN/MQTT/NB-IoT integrations, device-template catalogue with payload decoders, white-label with custom domain, rules/alerts, reseller programme.
- (b) Cheap, fast dashboards; transparent per-device price.
- (c) No real OTA/firmware management; scale limits.
- (d) Free tier then per-device/month plans; white-label is a separate plan (verify amounts).

**ThingsBoard** (https://thingsboard.io/pricing)
- (a) Apache-2.0 CE plus PE/Cloud; visual rule engine, widgets, device profiles, OTA, RPC, white-labelling (PE), customer hierarchy, edge, ChirpStack/TTN integrations.
- (b) Free self-host, flexible, big community.
- (c) Ops burden; steep learning curve; features gated in PE.
- (d) CE free; PE/Cloud tiered per device (verify).

**Akenza** (https://akenza.io)
- (a) Swiss LoRaWAN/enterprise core: device-type library with large decoder set, visual data flows (connectors, logic, outputs), multi-tenant/white-label for integrators.
- (b) Integrator-friendly, EU-hosted, decoder library.
- (c) Smaller ecosystem; quote-heavy pricing.
- (d) Tiered by devices and data-flow volume; enterprise quote.

**The Things Industries (TTN / The Things Stack)** (https://www.thethingsindustries.com, https://github.com/TheThingsNetwork/lorawan-devices)
- (a) LoRaWAN network server. The open lorawan-devices repo holds vendor-contributed device profiles and JS payload formatters via reviewed PRs, surfaced in Console; Packet Broker roaming; gateway management; webhooks/MQTT.
- (b) Open community, large device library, self-hostable.
- (c) Formatter quality varies; community-network fair-use limits; paid support tiers.
- (d) Community free (fair use); Cloud plans per device per year; enterprise dedicated.

**ChirpStack** (https://www.chirpstack.io)
- (a) Open-source LoRaWAN server; device profiles with JS codecs, multicast, FUOTA, integrations (MQTT, HTTP, InfluxDB).
- (b) Free, simple, stable.
- (c) No polished SaaS UI, no fleet analytics; community support.
- (d) Free (MIT); paid support via partners.

**Mender** (https://mender.io/plans/pricing)
- (a) Embedded-Linux OTA: A/B rootfs with auto-rollback, delta updates (Professional+), phased and scheduled deployments, groups, remote terminal, port-forward, audit logs, SAML/2FA, open-source server, Mender MCU for RTOS.
- (b) Robust rollback; open source; Yocto integration.
- (c) Linux-centric learning curve; features gated by tier.
- (d) Starter ~$29/mo (50 devices), Professional from ~$249/mo (250 devices) (agg: https://hub.mender.io/t/new-mender-professional-pricing/1634); Enterprise quote.

**Toit** (https://toit.io) - ESP32 Toit-language containers, live reload, managed deploys. Small user base, activity unclear (verify). Pricing: verify.

Cross-cutting: users praise transparent pricing, quick onboarding, open SDKs and rollback safety. They complain about opaque per-message fees, module/OS lock-in, tier-gated features and shallow analytics.

## Top 15 gaps for #8 (ranked)

1. **Embedded observability SDK** (Memfault): crash/coredump capture, symbolication, dedup, reboot reasons, heartbeat metrics tied to releases. Feeds health score and OTA gates with real data. Personas: OEM, Developer.
2. **Delta and A/B OTA with auto-rollback** (Mender, balena, nRF): smaller cellular downloads, atomic safe swap. #8 has waves and gates but no binary diff or dual-bank semantics. Personas: OEM, Installer.
3. **Device-side SDKs and reference firmware** (Golioth, Particle): Zephyr, ESP-IDF, FreeRTOS, Linux agent implementing codec, OTA, config, certs, logs. Cuts time-to-first-message. Personas: Developer, OEM.
4. **Declarative data pipelines** (Golioth Pipelines, Blues Routes, Akenza flows): YAML/visual routing with transformers to warehouse, webhook, MQTT, S3. Extends decoders into delivery. Personas: Solution, Developer.
5. **Shared cloud/device state** (Particle Ledger, shadows, Blues env vars): offline-tolerant two-way config; complements drift detection. Personas: Developer, Solution.
6. **Remote shell and port-forward** (Mender, balena): browser terminal without VPN. Personas: Developer, Installer.
7. **Remote logs** (Golioth, balena): searchable streaming device logs with levels and retention. Personas: Developer, Installer.
8. **Cellular data cost optimisation** (Particle, Blues prepaid): per-device data budgets, anomaly caps, auto-suspend, forecasting, efficient encodings (CBOR, batching). Builds on your SIM layer. Personas: Solution, OEM.
9. **Dev-to-prod promotion workflow**: dev/staging/prod environments promoting codecs, configs, automations and OTA artifacts as signed releases with diff review. Golioth cohorts and Mender groups are partial. Personas: OEM, Developer.
10. **Open device-type repository** (TTN lorawan-devices, Akenza, Datacake): community PRs, CI-validated profiles and decoders, versioned test vectors, import from TTN/ChirpStack. Your codec spec and catalog are close; the gap is open contribution and network effect. Personas: OEM, Solution, Developer. (Re-recommended because TTN's repo is notably more open.)
11. **White-labelling and end-customer portals** (Datacake, Losant Experiences, ThingsBoard PE): custom domain/branding per tenant; partners resell. Personas: Solution, OEM.
12. **Transparent per-device pricing calculator** (Golioth, Mender, balena): published formula, live estimator, free developer tier, no hidden quotas. A wedge against Particle/Memfault. Persona: all, esp. Developer.
13. **Power profiling and battery analytics** (Blues, Nordic PPK, Memfault): drain per firmware version, wake and sync cadence insight. Personas: OEM, Developer.
14. **Location services** (nRF Cloud, Blues): assisted GNSS and cell/Wi-Fi geolocation API for asset tracking. Personas: Solution, Installer.
15. **Visual workflow builder with app templates** (Losant, ThingsBoard rule chains): non-developers build automations and customer apps; #8 automations exist but lack a canvas and templates. Personas: Solution, Installer.

Protect your lead: none of the 14 platforms offers Excel-to-codec generation, AI agents with MCP, a marketplace or ABAC.

## 5 anti-patterns to avoid

1. **Opaque per-message or data-operation pricing** (Particle, Losant): unpredictable bills kill trust; publish unit prices.
2. **Hardware or OS lock-in as the moat** (Particle, Nordic, Blues): shrinks the market; stay protocol- and SDK-neutral.
3. **Gating safety features behind enterprise tiers** (Mender delta/2FA, ThingsBoard PE): rollback, audit and 2FA should be baseline; gate scale and support.
4. **Self-host-only complexity** (ChirpStack, ThingsBoard CE): high ops burden; managed first, self-host optional.
5. **Connectivity without insight** (Datacake, TTN, ChirpStack): "online" status without crash, log, metric and release correlation leaves users blind; pair every OTA feature with health data.
