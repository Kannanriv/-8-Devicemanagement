import type { FastifyBaseLogger } from "fastify";
import type { AppConfig } from "./config";
import { Core } from "./context";
import { openDb } from "./db/db";
import { createRepos } from "./db/repos";
import { InMemoryBus } from "./bus/bus";
import { LiveHub } from "./live/hub";
import { CodecService } from "./codecs/codec-service";
import { IntegrationService } from "./services/integrations";
import { AlertService } from "./services/alerts";
import { CommandService } from "./services/commands";
import { DeviceService } from "./services/devices";
import { AutomationService } from "./services/automations";
import { OtaService } from "./services/ota";
import { FirmwareService } from "./services/firmware";
import { StatsService } from "./services/stats";
import { AgentService } from "./services/agents";
import { SpecImportService } from "./services/spec-imports";
import { Pipeline } from "./pipeline/pipeline";
import { CredentialService } from "./services/credentials";
import { AssetService } from "./services/assets";
import { BulkService } from "./services/bulk";

/** Wires storage, bus and services. Transports/tickers are started separately (see index.ts / runtime.ts). */
export async function createPlatform(config: AppConfig, log: FastifyBaseLogger) {
  const db = await openDb(config.db);
  const repos = createRepos(db);
  const bus = new InMemoryBus((err, topic) => log.warn({ err, topic }, "bus handler failed"));
  const live = new LiveHub();
  const codecs = new CodecService(repos);
  const core = new Core(config, db, repos, bus, live, codecs, log);

  const integrations = new IntegrationService(core);
  const alerts = new AlertService(core, integrations);
  const commands = new CommandService(core);
  const devices = new DeviceService(core, integrations);
  const automations = new AutomationService(core, { alerts, commands, devices, integrations });
  devices.onLifecycle((d, _from) => automations.onLifecycle(d, d.lifecycle));
  const ota = new OtaService(core, { alerts, integrations });
  const firmware = new FirmwareService(core);
  const stats = new StatsService(core);
  const agents = new AgentService(core, { alerts, commands, ota, stats });
  const specImports = new SpecImportService(core, agents);
  const credentials = new CredentialService(core);
  const assets = new AssetService(core, devices);
  const bulk = new BulkService(core, { devices, commands, ota, assets });
  const pipeline = new Pipeline(core, { devices, automations, integrations, commands }, config.pipelineConcurrency);

  const platform = { config, core, db, repos, bus, live, codecs, integrations, alerts, commands, devices, automations, ota, firmware, stats, agents, specImports, pipeline, credentials, assets, bulk };
  return platform;
}

export type Platform = Awaited<ReturnType<typeof createPlatform>>;
