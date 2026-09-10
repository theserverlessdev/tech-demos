import type { BindingName, BlueprintInfo, GadgetFiles } from "../shared/types";

import slidesManifest from "../blueprints/slides/blueprint.json";
import slidesServer from "../blueprints/slides/server.js";
import slidesClient from "../blueprints/slides/client.js";
import slidesReadme from "../blueprints/slides/README.md";

import tictactoeManifest from "../blueprints/tictactoe/blueprint.json";
import tictactoeServer from "../blueprints/tictactoe/server.js";
import tictactoeClient from "../blueprints/tictactoe/client.js";
import tictactoeReadme from "../blueprints/tictactoe/README.md";

import pixelsManifest from "../blueprints/pixels/blueprint.json";
import pixelsServer from "../blueprints/pixels/server.js";
import pixelsClient from "../blueprints/pixels/client.js";
import pixelsReadme from "../blueprints/pixels/README.md";

import headlinesManifest from "../blueprints/headlines/blueprint.json";
import headlinesServer from "../blueprints/headlines/server.js";
import headlinesClient from "../blueprints/headlines/client.js";
import headlinesReadme from "../blueprints/headlines/README.md";

export type Blueprint = BlueprintInfo & { files: GadgetFiles };

function blueprint(
  manifest: Omit<BlueprintInfo, "bindings"> & { bindings: string[] },
  server: string,
  client: string,
  readme: string,
): Blueprint {
  return {
    id: manifest.id,
    title: manifest.title,
    icon: manifest.icon,
    description: manifest.description,
    prompt: manifest.prompt,
    bindings: manifest.bindings as BindingName[],
    files: { "server.js": server, "client.js": client, "README.md": readme },
  };
}

export const BLUEPRINTS: Blueprint[] = [
  blueprint(slidesManifest, slidesServer, slidesClient, slidesReadme),
  blueprint(tictactoeManifest, tictactoeServer, tictactoeClient, tictactoeReadme),
  blueprint(pixelsManifest, pixelsServer, pixelsClient, pixelsReadme),
  blueprint(headlinesManifest, headlinesServer, headlinesClient, headlinesReadme),
];

export const BLUEPRINT_INFOS: BlueprintInfo[] = BLUEPRINTS.map(({ files: _files, ...info }) => info);

export function getBlueprint(id: string): Blueprint | undefined {
  return BLUEPRINTS.find((b) => b.id === id);
}
