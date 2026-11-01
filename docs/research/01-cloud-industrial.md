# 01 - Hyperscaler and Industrial IoT Platforms (research for #8 Device Cloud)

Method note: only a few web searches ran for this brief, so most platform detail below comes from prior knowledge of vendor docs, not fresh fetches. Items with an inline URL come from search results. Items marked (unverified) need a docs check before they go into a roadmap. Review data is thin: G2 and Gartner list no public pricing for Cumulocity, ThingWorx or Insights Hub ([G2 compare](https://www.g2.com/compare/cumulocity-vs-thingworx-industrial-iot-platform)).

## 1. Platform by platform

### AWS IoT (Core, Device Management, Defender, FleetWise, SiteWise, Greengrass)
**(a) Standouts**
- Fleet indexing: a searchable index over registry, shadow, connectivity and Defender violation data, with a query language, aggregations (count, percentile, cardinality) and dynamic thing groups ([pricing](https://aws.amazon.com/iot-device-management/pricing)).
- Jobs: rollouts with rate ramp-up, abort criteria, retries, scheduling and maintenance windows.
- Secure tunneling: browser or SSH access to a remote device.
- Device Defender: Audit (shared certs, expiring certs, over-permissive policies) plus Detect (behavior metrics, ML anomalies) ([pricing](https://www.aws.amazon.com/iot-device-defender/pricing/)).
- Fleet provisioning templates and just-in-time registration.
- Managed integrations: newer feature abstracting multi-vendor, multi-protocol devices.
- FleetWise: vehicle signal campaigns with edge-side conditional collection.
- SiteWise: asset models and hierarchies, computed metrics, OPC-UA gateway.
- Greengrass: edge runtime with components, local deployment, stream manager.
- Fleet Hub (console dashboard) was discontinued 2025-10-18 and folded into the Device Management console ([FAQ](https://aws.amazon.com/iot-device-management/faq/)).

**(b) Loved:** scale, the fleet indexing query language, mature Jobs, deep security model.
**(c) Complained about:** many separate services and consoles, steep learning curve, IAM/policy complexity, cost surprises at scale, lock-in.
**(d) Pricing:** pay-as-you-go per message, registered thing, query ($0.05 per 10k fleet queries in AWS's example), audit and datapoint; free tier.

### Microsoft Azure IoT (IoT Hub, DPS, Device Update, IoT Operations, Digital Twins)
**(a) Standouts**
- IoT Hub device twins with tag and property queries.
- Automatic device management: configurations targeted by twin query, with metrics-based success criteria.
- DPS enrollment groups with allocation policies for zero-touch, geo-aware onboarding.
- Device Update: signed image/package updates, deployment groups, rollback policy.
- IoT Operations: Arc-enabled Kubernetes edge stack with MQTT broker, OPC-UA connector, dataflows; Device Registry is GA for Operations, IoT Hub integration in preview ([Microsoft Learn](https://learn.microsoft.com/en-us/azure/iot/iot-device-registry-overview)).
- Digital Twins: DTDL ontologies and twin graph (2026 status unverified).
- IoT Central is being retired; sources conflict on the date (2027-03-31 vs 2029-09-20, see [AZ569914](https://mc.merill.net/message/AZ569914)).

**(b) Loved:** DPS, twin-based targeting, Azure/Entra fit.
**(c) Complained about:** product churn (Central, Percept), edge/Kubernetes complexity of IoT Operations, confusing product map.
**(d) Pricing:** IoT Hub per unit per day by tier with message quota; DPS per operation; Operations per core (unverified).

### Siemens Insights Hub (MindSphere)
**(a) Standouts:** asset and aspect modeling, Industrial Edge app runtime on Siemens hardware, Mendix low-code tie-in, Siemens app marketplace. Native S7/OPC-UA connectivity is the moat.
**(b) Loved:** ease of use and features ([G2](https://www.g2.com/compare/cumulocity-iot-vs-siemens-digital-industries-software-insights-hub)), integration with Siemens automation.
**(c) Complained about:** learning curve, limited customization, repackaging that cut API rate limits and hurt budgets ([Gartner](https://www.gartner.com/reviews/product/insights-hub/alternatives)).
**(d) Pricing:** quote-based subscription tiers by asset and data volume (details unverified).

### PTC ThingWorx / Kepware
**(a) Standouts:** model-driven Thing/ThingShape/ThingTemplate design, Mashup Builder for drag-and-drop apps, Kepware's 150+ industrial drivers (Modbus, OPC-UA, Allen-Bradley), Analytics Manager for anomaly and prediction, OEE/downtime dashboards.
**(b) Loved:** rapid app building, protocol breadth via Kepware, mature industrial base.
**(c) Complained about:** "costly to implement and operate" ([Gartner](https://www.gartner.com/reviews/product/ptc-thingworx/alternatives)), heavy platform, partner dependence. G2 3.9 from 33 reviews.
**(d) Pricing:** quote-based subscription; Kepware licensed per driver and tag count.

### Cumulocity IoT
**(a) Standouts:** strong device-management core (inventory, firmware/software/config repositories, bulk operations), microservice hosting for customer code, Streaming Analytics rules, alarm model with severities, DataHub lake offload, Web SDK for custom UIs, LWM2M, and thin-edge.io open source edge agent.
**(b) Loved:** UI and device management. G2 4.3 from 13 reviews; Gartner 4.5 from 187.
**(c) Complained about:** beginner difficulty and hard customization ([G2](https://www.g2.com/compare/cumulocity-iot-vs-siemens-digital-industries-software-insights-hub)).
**(d) Pricing:** quote-based, free trial.

### Bosch IoT Suite
**(a) Standouts:** Eclipse Ditto digital twins, Eclipse Hono, hawkBit-based rollouts (rollout groups). Open-source roots mean low lock-in. Current commercial availability is unverified.
**(b) Loved:** open standards, Ditto's twin model and policies.
**(c) Complained about:** fragmented services, thin UI/docs, small commercial ecosystem (unverified).
**(d) Pricing:** per-service subscription (unverified).

### Litmus Edge
**(a) Standouts:** edge-first data platform with 250+ drivers (OPC-UA, Modbus, Siemens, Rockwell), tag-level data model, flow transforms, edge analytics, central manager to push config and apps to many sites, unified namespace (UNS) positioning.
**(b) Loved:** fast OT connectivity, plant-floor usability.
**(c) Complained about:** limited cloud-side analytics, hardware and license cost, smaller ecosystem (unverified).
**(d) Pricing:** per-edge-instance license by tag/device tier (unverified).

### Google Cloud IoT Core (retired 2023-08-16)
Google announced in Aug 2022 that customers "could be better served by our network of partners", with a one-year runway and ClearBlade as a migration option ([RCR](https://www.rcrwireless.com/20220816/internet-of-things/google-cloud-to-shut-down-iot-core-service-next-year), [IoT World Today](https://www.iotworldtoday.com/2022/08/23/google-cloud-to-shut-down-iot-core-service/)). Commentators tied it to cloud losses and Google's habit of killing products (Android Things).
**Lessons**
- It was a thin broker plus registry with no lifecycle, OTA, fleet query or app layer, so it was easy to cancel and replace.
- Customers will not build on a vendor that treats IoT as a side product; longevity is a feature.
- Missing jobs, OTA and twins forced users to assemble extra services, so there was no moat.
- The abrupt exit destroyed trust. #8 needs a published deprecation and data-export policy.

## 2. TOP 15 features or workflows #8 lacks

| # | Feature | Why it matters | Persona |
|---|---|---|---|
| 1 | Fleet index and query language (saved queries, aggregations, dynamic groups over drift, health, telemetry; AWS fleet indexing, Azure twin queries) | One query surface drives targeting, dashboards, jobs and agents | OEM, Solution co. |
| 2 | Generic Jobs engine (any command, script or config to dynamic groups with rate ramp, abort thresholds, maintenance windows) | Generalizes OTA waves to every operation | OEM, Installer |
| 3 | Defender-style security audits and behavior detection (shared/expiring certs, over-broad grants, abnormal traffic) | Turns X.509 storage into continuous assurance; a procurement checkbox | OEM, Solution co. |
| 4 | Device shadow / digital twin (desired vs reported state, offline command queueing, twin graph) | Standard abstraction for apps and offline devices | Developer, Solution co. |
| 5 | Edge runtime and agent (containerized components, local decode, store-and-forward, offline rules) | Industrial sites lose connectivity; edge execution is expected | Solution co., Installer |
| 6 | Industrial connector library (OPC-UA, Modbus, S7, BACnet), with Codec Spec generating tag maps | Opens OT buyers and reuses the codec moat | Installer, Solution co. |
| 7 | Asset models and hierarchies (site, line, machine; metrics roll up; SiteWise) | Attaches KPIs and alarms to business objects, not devices | Solution co. |
| 8 | Condition monitoring and alarm engine (thresholds, severities, rate-of-change, ack/clear lifecycle, escalation) | Turns telemetry into operator work | Solution co., Installer |
| 9 | Predictive maintenance and anomaly detection (baselines, remaining-life scores) | Highest-value outcome industrial buyers pay for | Solution co. |
| 10 | Data pipelines and lake export (transforms, Kafka/S3/warehouse sinks, retention tiers) | Customers refuse silos; needed for BI and ML | Developer, Solution co. |
| 11 | Secure tunneling / remote access (SSH, web UI, shell, audited) | Field troubleshooting without a truck roll | Installer, OEM |
| 12 | Zero-touch / fleet provisioning (claim certs, enrollment groups, allocation policies; Azure DPS) | Cuts installer time and scales manufacturing | OEM, Installer |
| 13 | Low-code app and dashboard builder with embeddable widgets (ThingWorx Mashups, Cumulocity SDK) | Lets Solution companies ship customer apps on #8 | Solution co., Developer |
| 14 | Unified namespace and open data model (UNS topics, Sparkplug B, Ditto/DTDL import-export) | Neutral, standards-based stance against lock-in | Developer, Solution co. |
| 15 | Extension / microservice hosting (customer code beside the platform) | Platform becomes a place to build, feeding the marketplace | Developer |

Notes: rows 3, 11 and 12 are cheap wins. Rows 6 and 7 plus the Codec Spec give #8 a distinct industrial story. Vehicle signal collection (FleetWise) is a later vertical.

## 3. Five anti-patterns to avoid
1. **Service sprawl (AWS, Azure).** Dozens of separately billed services and consoles. Keep one console, one object model, one bill, with persona workspaces on top.
2. **Product churn and abrupt retirement (Google IoT Core, Azure Central, AWS Fleet Hub).** Publish a support policy, long runways and full data/config export. Trust is a feature.
3. **Thin broker with no lifecycle (Google IoT Core).** Connectivity is a commodity. Keep codecs, lifecycle and ecosystem central.
4. **Heavyweight, partner-dependent implementation (ThingWorx, Insights Hub).** Ship opinionated templates and a working first day; track time to first decoded device.
5. **Quote-only, shifting pricing and API limits (Insights Hub).** Publish pricing and rate limits, grandfather customers, and avoid per-query bill shock (AWS).

## 4. Gaps to verify next
- Bosch IoT Suite status, Cumulocity ownership, Litmus pricing.
- Azure IoT Central retirement date (conflicting sources).
- Reddit and Hacker News sentiment was not collected and should be sampled.
