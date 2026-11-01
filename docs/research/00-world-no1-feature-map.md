# World No.1 feature map: synthesis of the platform research

This map draws on the three research reports in this folder:
- `01-cloud-industrial.md`: AWS, Azure, Siemens, PTC, Cumulocity, Bosch, Litmus, and Google's retired IoT Core.
- `02-device-centric.md`: Particle, Golioth, Memfault, Balena, Nordic, Blues, Losant, Datacake, ThingsBoard, Akenza, TTI/TTN, ChirpStack, Mender, Toit.
- `03-ecosystem-connectivity.md`: Tuya, Samsara, Hologram, 1NCE, Kore, Telit/Kigen, Soracom, Matter/CSA, AWS Partner Device Catalog, AppExchange, Shopify, ServiceNow.

**Caveat:** the agents ran a limited number of searches. Items marked *unverified* in the source files come from model knowledge, and pricing figures should be confirmed before anyone cites them externally.

## Our moat (protect it)
None of the 30 platforms reviewed combines these:
- **Excel spec → verified codec → plugins in 6 languages**;
- **AI agents and MCP**;
- an **ecosystem marketplace with fulfilment wired into operations**;
- **ABAC app grants**;
- **outcome-driven persona workspaces**.

Every feature below should strengthen one of these, not dilute it.

## The 12 themes we add, ranked by impact on becoming no.1

| # | Theme | Folds together | Workspace | Priority |
|---|---|---|---|---|
| 1 | **Fleet query language and dynamic groups** | AWS fleet indexing, Azure twin query. Saved queries become groups, which become targets for jobs, KPIs and agents. | Fleet | P0 |
| 2 | **Jobs engine (generalised OTA)** | AWS Jobs, Mender. Any command, config, script or firmware goes to a dynamic group, with ramp, abort thresholds and maintenance windows. Adds **delta and A/B OTA** with auto-rollback. | Operate | P0 |
| 3 | **Embedded observability** | Memfault, Golioth logs. Crash and coredump capture, reboot reasons, remote logs, heartbeat metrics per release, power and battery drain per firmware. These feed the health score and the OTA gates. | Fleet (Device 360), Insights | P0 |
| 4 | **Device twin (desired/reported) and remote access** | Shadows, Particle Ledger, AWS tunneling, Mender shell. An offline-tolerant twin, plus an audited browser shell and port-forward. | Fleet (Device 360) | P0 |
| 5 | **Zero-touch provisioning and device SDKs** | Azure DPS, Golioth/Particle SDKs. Claim certificates, enrollment groups, allocation policies. Reference firmware SDKs (Zephyr, ESP-IDF, FreeRTOS, Linux agent) that implement codec, OTA, config, certificates and logs. Measured by time-to-first-message. | Fleet (Onboard), Developer | P0 |
| 6 | **Connectivity cost control (eSIM)** | Soracom, Hologram, 1NCE. SGP.32 profile switching, pooled data budgets, auto-switch on cost or coverage, bill-shock caps, forecasting. | Fleet (Connectivity) | P0 |
| 7 | **Alarms → work orders → field service, and warranty/RMA** | Cumulocity alarms, ServiceNow FSM. Alarm lifecycle and escalation. Work orders dispatched by skill and location, with a mobile checklist, serial scan and photos, and auto-close when telemetry recovers. RMA flows feed failure reasons back to OEM quality. | Operate, Installer persona | P0 |
| 8 | **Ecosystem flywheel** | Tuya, AppExchange, Shopify. Covers: <br>• lead routing to distributors (territory and capacity rules, SLA timers) <br>• listing analytics <br>• partner tiers earned from performance <br>• co-marketing <br>• revenue share and payouts <br>• app security vetting <br>• developer sandbox tenants <br>• a "Works with #8" badge that is objective and test-based | Ecosystem, Sell | P0 |
| 9 | **White-label OEM app and customer portals** | Tuya OEM app, Datacake, Losant Experiences. A branded end-user app and portal generated from the codec spec (pairing, sharing, OTA, invoices, tickets), plus embeddable widgets and custom domains. | Ecosystem, Sell, Admin | P1 |
| 10 | **Data pipelines and open data** | Golioth Pipelines, Blues Routes, SiteWise. Declarative and visual routes with transforms and sinks (warehouse, S3, Kafka, MQTT). UNS/Sparkplug B, DTDL import and export. A full data export guarantee. | Developer, Operate | P1 |
| 11 | **Assets, industrial connectors, predictive** | SiteWise asset models, OPC-UA/Modbus/BACnet, where the codec spec generates the tag maps. Condition monitoring, anomaly baselines and remaining-life scores. | Fleet (Assets), Insights | P1 |
| 12 | **Open device repository, low-code apps, sustainability** | TTN device repo, ThingWorx Mashups, ESG reporting. Community-contributed codecs with CI vectors; a visual workflow and app builder; carbon and energy rollups for RFPs; device resale and transfer. | Ecosystem, Insights | P2 |

Also add **Security posture (Defender-style audits)**, which counts as a cheap P0 win. It covers shared or expiring certificates, over-broad app grants, abnormal traffic, and a posture score. Workspace: Admin → Security.

## Principles from the anti-patterns
1. **One console, one object model, one bill.** No service sprawl.
2. **Published, per-device pricing**, with a live calculator and a free developer tier. No bill shock.
3. **Safety is baseline.** Rollback, audit, 2FA and RBAC are never gated behind enterprise tiers; we gate scale and support instead.
4. **Trust and longevity.** A public deprecation policy, plus full data, config and codec export.
5. **Certification is earned by tests, never bought.** Every listing has a lead flow and an owner SLA.
6. **Managed first, self-host optional.** Opinionated templates give a working first day.
7. **Every OTA and connectivity feature is paired with health insight.**

## How this lands in the build
- **Wave 2 (frontend, mock data)**: all P0 themes get real screens and flows in their workspaces. P1 themes get their contract and an entry screen.
- **Wave 3 (QA)** checks that every P0 flow can be walked end to end with the mock data.
- **Wave 4 (backend)** implements P0 first: fleet query, jobs, twin, provisioning, alarms and work orders, lead routing, and payouts. It reuses ops-engine, codec-runtime and ecosystem.
- **Later**: delta OTA binaries, device SDKs (C/Zephyr, building on the C codec target), eSIM integration with real SM-DP+/SGP.32 providers, and industrial connectors.
