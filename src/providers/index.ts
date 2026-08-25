import type { Config, CustomProviderConfig } from "../config.js";
import type { SearchProvider, ProviderSearchOptions } from "./base.js";
import { DuckDuckGoProvider } from "./ddg.js";
import { BingProvider } from "./bing.js";
import { WikimediaProvider } from "./wikimedia.js";
import { OpenverseProvider } from "./openverse.js";
import { SerperProvider } from "./serper.js";

export * from "./base.js";
export { DuckDuckGoProvider, BingProvider, WikimediaProvider, OpenverseProvider, SerperProvider };

/** Build the enabled provider list from config. */
export function createProviders(cfg: Config): SearchProvider[] {
  const map = new Map<string, SearchProvider>();
  const add = (p: SearchProvider) => map.set(p.name, p);
  for (const name of cfg.providers) {
    switch (name) {
      case "ddg":
        add(new DuckDuckGoProvider());
        break;
      case "bing":
        add(new BingProvider());
        break;
      case "wikimedia":
        add(new WikimediaProvider());
        break;
      case "openverse":
        if (cfg.openverseToken) add(new OpenverseProvider(cfg.openverseToken));
        break;
      case "serper":
        if (cfg.serperApiKey) add(new SerperProvider(cfg.serperApiKey));
        break;
      default:
        // Unknown provider names are ignored with a warning at the service layer.
        break;
    }
  }
  return [...map.values()];
}

export type { SearchProvider, ProviderSearchOptions };
export type { CustomProviderConfig };
