# #8 Device Cloud: an outcome-driven IoT ecosystem (redesign)

Status: proposal for approval · 2026-11-01

## 1. Why we are redesigning

The first console was built module by module: Inventory, Lifecycle, Health, OTA, Codecs and 15 more. Each module is a table of records. It is **data-driven**: it shows what exists. The user needs it to be **outcome-driven**, meaning it shows what each person is trying to achieve, what blocks them, and the one action that moves the number.

It must also do more than manage devices. Device management becomes one part of an **IoT ecosystem** with three parties:
- **OEMs (device makers)** launch and **market** their devices.
- **Solution companies** discover, buy, integrate and operate those devices.
- **Apps** (the #8 products and third-party billing, CRM and ERP) plug in.

### What the market teaches (research)
| Reference | What they get right | What we take |
|---|---|---|
| Tuya (1.2M SKUs, OEM launch "in 30 days", Matter certification help, OEM app) | The platform *is* the OEM's route to market | **Launch Studio** and a **Device Marketplace** with certification badges |
| Particle, Golioth | One path from the device to the cloud, and a developer-first experience | **Time to first decoded message** as a headline outcome, and a developer portal |
| Memfault | Outcome metrics (crash-free hours, update adoption) instead of raw logs | Each module is framed as an **outcome with a target** |
| Samsara | Role-based operations and an app marketplace | **Persona workspaces** and an **App Marketplace** |
| AWS Partner Device Catalog, Works-with programs | Certification sells devices | Certification levels that buyers can filter by |
| Linear, Stripe, Vercel (product UX canon) | Keyboard-first, restraint, tables as the interface, one level of detail at a time | ⌘K for everything, flat surfaces, colour only on meaning |

Our wedge, which none of them have: **Excel spec → verified codec → plugins in 6 languages → live decoding**. The codec travels with the device through sale, transfer and firmware updates.

## 2. Personas and their outcomes (the north stars)

| Persona | Job | Outcome metrics shown on their home |
|---|---|---|
| **OEM** (device maker) | Launch devices and get them adopted | Days from spec to listing, launch readiness %, buyers adopting the decoder, devices activated in the field, firmware adoption %, field failure rate |
| **Solution company / operator** | Turn purchased devices into revenue-generating, healthy deployments | % of fleet *revenue-ready* (activated and reporting fresh data), days from install to first data, data freshness SLA, MTTR, OTA success rate, cost per connected device |
| **Installer / field** | Install right the first time | Jobs today, first-time-right %, devices waiting for activation |
| **Integrator / developer** (buyer's engineer) | Get device data into their own app | Time to first decoded message, plugin downloads, webhook health |

A **persona switcher** in the shell changes the home page, the order of the navigation and the copilot's suggestions. Demo mode lets you jump between personas.

## 3. Information architecture (6 workspaces replace 20 modules)

1. **Today (home).** For each persona:
   - **Outcome board:** 3–5 goals, each with target, current value, trend, *what's blocking*, and a one-click **Playbook**.
   - **Action queue:** the Ops Inbox, ranked by impact on an outcome.
   - **AI briefing:** "3 things changed since yesterday".
2. **Launch (OEM).** Launch Studio is a guided runway: Model → Spec (drop Excel) → Codec verified → Firmware signed → Certification → Storefront listing → Go live.
   - A readiness score, with blockers explained.
   - A live preview of the storefront page as the OEM edits it.
3. **Ecosystem** (full model in `docs/ecosystem-model.md`: participants, relations, flows, deals, releases, programs). It includes:
   - **Device Catalog:** a storefront for buyers. Each device has:
     - a hero section, specs and a datasheet;
     - a *live decoder playground* (paste hex → JSON);
     - certification badges and compatible networks and apps;
     - **Adopt decoder / Request quote / Order samples** actions.
   - **App Marketplace:** the #8 products (SIM, Gateway, Asset, IoT CRM/billing, Ticketing, Installation, Customer apps) and third-party apps (Salesforce, HubSpot, Zoho, SAP, Stripe, Razorpay, ServiceNow, Slack, Teams, Power BI and more). Each can be installed in a few clicks.
   - **Partners:** distributors, installers and connectivity providers.
   - **Ecosystem map:** an interactive graph of who builds, sells, runs and integrates which devices.
4. **Fleet (operator).** Devices table, Device 360 (live twin, raw↔decoded stream, timeline), Onboarding wizard, a Lifecycle *pipeline* (kanban/funnel from registered to activated, with where devices are stuck), Health, Connectivity and SIM.
5. **Operate.**
   - **Playbooks:** guided, multi-step operations with preview, permission check, progress and per-device results.
   - Rollouts (OTA), Commands & diagnostics, Automations, Incidents & alerts.
6. **Insights.** Outcome reports, cohort analysis, exportable reports.

**Developer portal:** API keys, SDKs, plugin downloads, webhooks, the decoder playground and docs. **Admin:** organisation, members and roles, security, audit, plan and billing.

## 4. The interactions that make it premium
- **⌘K command bar** that *executes*. Typing "roll out 2.4.0 to Pune GT200 canary" opens a pre-filled playbook.
- **Copilot drawer.** It explains any metric, writes automations and drafts playbooks, and asks for approval before any write.
- **Signature visuals:**
  - a *Fleet Pulse* (live message flow by protocol and region);
  - the *Launch Runway*;
  - the *Lifecycle Pipeline*;
  - the *Ecosystem Map*;
  - a byte-level hex↔field inspector.
- **Motion system.** Spring-based transitions (150–250ms) that can be interrupted, live counters, optimistic updates, skeleton screens instead of spinners, and full support for reduced motion.
- **Visual language.** #8 obsidian, porcelain and gradient brand in **dark and light** themes. Flat surfaces with 1px rules, colour reserved for meaning (good/bad/needs action), Inter Tight with tabular numerals, honest empty and zero states, and words of the trade instead of generic nouns.
- **Accessible and fast.** Keyboard reaches every action, WCAG AA contrast, phone layouts for installer screens.

## 5. How we build it: frontend first

At the user's direction, we build **the complete frontend first, then the backend**.

- **Mock data layer:** `apps/console/src/data/` defines a typed `DataSource` interface with two implementations:
  - `mock`: rich deterministic fixtures, simulated live ticks and persona-aware data. It is the default for now.
  - `live`: the existing Fastify API on :4000.

  An env flag switches between them. The frontend is therefore not blocked on the backend, and the mock layer **becomes the backend contract**.
- **Backend phase:** afterwards, implement every `DataSource` method that `live` doesn't serve yet. The existing API, codec runtime, ecosystem package and ops-engine are reused.
- **The current console** is replaced, not patched. Logic worth keeping (the hex inspector, bulk flow, codec form) is moved into the new structure.

### Skills used (vetted from skills.sh and installed in `.claude/skills`)
- **Design direction:** frontend-design (Anthropic), **design-taste-frontend** (taste-skill, app-screens chapter), **emil-design-eng** and **apple-design** (motion and polish), review-animations.
- **Quality:** web-design-guidelines, vercel-react-best-practices, vercel-composition-patterns, shadcn, tailwind-design-system, webapp-testing (Playwright screenshots).
- **Skipped:** impeccable, because it downloads a binary on first run.

### Agent team (waves, to stay within usage limits)
- **Wave 1: Design system and shell (1 agent plus the lead).** Tokens for both themes, motion primitives, the component kit, the shell with persona switcher, ⌘K, the copilot drawer, and the DataSource and mock layer skeleton.
- **Wave 2: Workspaces, five agents in parallel with disjoint folders:**
  1. Today and Insights, plus Playbooks.
  2. Launch Studio and the Device Catalog storefront with the decoder playground.
  3. App Marketplace, Partners, Ecosystem Map and the Developer portal.
  4. Fleet: devices, Device 360, onboarding and the lifecycle pipeline.
  5. Operate: rollouts, commands, automations, incidents, security and audit.
- **Wave 3: QA and design review agent.** Playwright screenshots of every screen in both themes at 1440 and 390 widths, a critique against the skills, accessibility checks, and fixes.
- **Wave 4: Backend.** Implement the live DataSource gaps (marketplace, launch, playbooks, outcomes, personas), then end-to-end tests.

The lead (Claude) owns the contracts, reviews every wave against the screenshots, and commits and pushes after each wave passes typecheck and screenshot review.

## 6. Done means
- Each persona's home answers "how are we doing on our goals, and what should I do next?" in the first viewport.
- An OEM can go from an Excel spec to a public storefront listing in one guided flow.
- A buyer can find a certified device, test its decoder live, adopt it, and connect an app from the marketplace.
- An operator can onboard devices, see where they are stuck, and fix it with a playbook.
- Every screen passes screenshot review in both themes and on a phone, and typecheck is clean.

## 7. Calls I made (please check)
- The product name in the shell is **#8 Device Cloud**, with Device Management as one workspace.
- Four personas, switchable from the shell.
- The current console is rebuilt, not incrementally polished.
- Mock-first frontend, with the backend after it.
- Third-party app names appear as integration targets only. Partner and OEM companies in demo data are fictional.
