
import "dotenv/config";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

const app = express();

app.use(cors());
app.use(express.json());

const sessions = new Map<string, {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}>();

const BASE_URL =
  "https://pronostics-footballistiques-mcp.onrender.com";

const serverCard = {
  "$schema":
    "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
  name: "com.onrender.pronostics-footballistiques-mcp/mcp",
  version: "1.0.0",
  description:
    "Serveur MCP d'analyse statistique et de pronostics footballistiques.",
  remotes: [
    {
      type: "streamable-http",
      url: `${BASE_URL}/mcp`
    }
  ]
};

const aiCatalog = {
  specVersion: "1.0",
  entries: [
    {
      identifier:
        "urn:air:pronostics-footballistiques-mcp.onrender.com:mcp:mcp",
      type: "application/mcp-server-card+json",
      url: `${BASE_URL}/mcp/server-card`
    }
  ]
};

// En-têtes publics pour les documents de découverte MCP.
function discoveryHeaders(
  contentType: string
) {
  return {
    "Content-Type": contentType,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET",
    "Access-Control-Allow-Headers":
      "Content-Type, If-None-Match",
    "Access-Control-Expose-Headers": "ETag",
    "Cache-Control": "public, max-age=3600"
  };
}

// --------------------------------------------------
// ROUTES PUBLIQUES DE DÉCOUVERTE MCP
// Elles doivent rester AVANT la protection /mcp.
// --------------------------------------------------

app.get("/mcp/server-card", (_req, res) => {
  res
    .status(200)
    .set(
      discoveryHeaders(
        "application/mcp-server-card+json"
      )
    )
    .send(JSON.stringify(serverCard));
});

// Emplacement de découverte complémentaire.
app.get(
  "/.well-known/mcp/server-card.json",
  (_req, res) => {
    res
      .status(200)
      .set(
        discoveryHeaders(
          "application/mcp-server-card+json"
        )
      )
      .send(JSON.stringify(serverCard));
  }
);

app.get(
  "/.well-known/ai-catalog.json",
  (_req, res) => {
    res
      .status(200)
      .set(
        discoveryHeaders(
          "application/ai-catalog+json"
        )
      )
      .send(JSON.stringify(aiCatalog));
  }
);

// --------------------------------------------------
// AUTHENTIFICATION MCP
// Toutes les autres routes /mcp nécessitent le token.
// --------------------------------------------------

function requireMcpToken(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const expectedToken = process.env.MCP_ACCESS_TOKEN;

  if (!expectedToken) {
    res.status(503).json({
      error: "Le serveur MCP n'est pas encore sécurisé."
    });
    return;
  }

  const authorization =
    req.get("authorization") || "";

  const suppliedToken =
    authorization.startsWith("Bearer ")
      ? authorization.slice(7)
      : "";

  const expected = Buffer.from(expectedToken);
  const supplied = Buffer.from(suppliedToken);

  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  ) {
    res.status(401).json({
      error: "Accès non autorisé."
    });
    return;
  }

  next();
}

app.use("/mcp", requireMcpToken);

// --------------------------------------------------
// OUTILS MCP
// --------------------------------------------------

function createMcpServer() {
  const server = new McpServer({
    name: "pronostics-footballistiques-mcp",
    version: "1.0.0"
  });

  server.tool(
    "diagnostic_fournisseurs",
    "Vérifie la présence des clés API configurées sans révéler leur valeur.",
    {},
    async () => {
      const providers = [
        {
          name: "API-Football",
          configured: Boolean(
            process.env.API_FOOTBALL_KEY
          )
        },
        {
          name: "football-data.org",
          configured: Boolean(
            process.env.FOOTBALL_DATA_TOKEN
          )
        }
      ];

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            status: "diagnostic_local",
            providers,
            message:
              "Ce diagnostic vérifie uniquement la présence des clés, pas leur validité."
          }, null, 2)
        }]
      };
    }
  );

  server.tool(
    "presentation",
    "Présente le fonctionnement et les limites du moteur de pronostics.",
    {},
    async () => ({
      content: [{
        type: "text",
        text:
          "Pronostics Footballistiques Mathématiques : moteur d'analyse statistique. Les prédictions ne seront publiées que lorsque les données nécessaires seront disponibles et vérifiables."
      }]
    })
  );

  return server;
}

// --------------------------------------------------
// SANTÉ DU SERVEUR
// --------------------------------------------------

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "pronostics-footballistiques-mcp",
    timestamp: new Date().toISOString()
  });
});

// --------------------------------------------------
// TRANSPORT MCP STREAMABLE HTTP
// --------------------------------------------------

app.post("/mcp", async (req, res) => {
  const sessionId =
    req.headers["mcp-session-id"] as string | undefined;

  try {
    const session = sessionId
      ? sessions.get(sessionId)
      : undefined;

    if (
      !session &&
      !sessionId &&
      isInitializeRequest(req.body)
    ) {
      const server = createMcpServer();

      const transport =
        new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, {
              server,
              transport
            });
          }
        });

      transport.onclose = () => {
        const id = transport.sessionId;

        if (id) {
          sessions.delete(id);
        }
      };

      await server.connect(transport);

      await transport.handleRequest(
        req,
        res,
        req.body
      );

      return;
    }

    if (!session) {
      res.status(400).json({
        error:
          "Session MCP inconnue. Initialisez une nouvelle session."
      });
      return;
    }

    await session.transport.handleRequest(
      req,
      res,
      req.body
    );
  } catch (error) {
    console.error(
      "Erreur MCP :",
      error instanceof Error
        ? error.message
        : "Erreur inconnue"
    );

    if (!res.headersSent) {
      res.status(500).json({
        error: "Erreur interne du serveur MCP."
      });
    }
  }
});

app.get("/mcp", (_req, res) => {
  res.status(405).json({
    error:
      "Utilisez le transport MCP Streamable HTTP."
  });
});

app.delete("/mcp", async (req, res) => {
  const sessionId =
    req.headers["mcp-session-id"] as string | undefined;

  const session = sessionId
    ? sessions.get(sessionId)
    : undefined;

  if (!session) {
    res.status(404).json({
      error: "Session introuvable."
    });
    return;
  }

  await session.transport.handleRequest(req, res);
});

// --------------------------------------------------
// DÉMARRAGE
// --------------------------------------------------

const port = Number(process.env.PORT || 3000);

app.listen(port, () => {
  console.log(
    `Serveur MCP démarré sur le port ${port}`
  );
});
