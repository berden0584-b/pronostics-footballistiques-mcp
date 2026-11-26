
import "dotenv/config";
import express from "express";
import cors from "cors";
import { randomUUID } from "node:crypto";
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
        { name: "API-Football", configured: Boolean(process.env.API_FOOTBALL_KEY) },
        { name: "football-data.org", configured: Boolean(process.env.FOOTBALL_DATA_TOKEN) }
      ];

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            status: "diagnostic_local",
            providers,
            message: "Ce diagnostic vérifie uniquement la présence des clés, pas leur validité."
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
        text: "Pronostics Footballistiques Mathématiques : moteur d'analyse statistique. Les prédictions ne seront publiées que lorsque les données nécessaires seront disponibles et vérifiables."
      }]
    })
  );

  return server;
}

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "pronostics-footballistiques-mcp",
    timestamp: new Date().toISOString()
  });
});

app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  try {
    let session = sessionId ? sessions.get(sessionId) : undefined;

    if (!session && !sessionId && isInitializeRequest(req.body)) {
      const server = createMcpServer();

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, { server, transport });
        }
      });

      transport.onclose = () => {
        const id = transport.sessionId;
        if (id) sessions.delete(id);
      };

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    if (!session) {
      res.status(400).json({
        error: "Session MCP inconnue. Initialisez une nouvelle session."
      });
      return;
    }

    await session.transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("Erreur MCP :", error instanceof Error ? error.message : "Erreur inconnue");
    if (!res.headersSent) {
      res.status(500).json({ error: "Erreur interne du serveur MCP." });
    }
  }
});

app.get("/mcp", (_req, res) => {
  res.status(405).json({ error: "Utilisez le transport MCP Streamable HTTP." });
});

app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const session = sessionId ? sessions.get(sessionId) : undefined;

  if (!session) {
    res.status(404).json({ error: "Session introuvable." });
    return;
  }

  await session.transport.handleRequest(req, res);
});

const port = Number(process.env.PORT || 3000);

app.listen(port, () => {
  console.log(`Serveur MCP démarré sur le port ${port}`);
});
