
import "dotenv/config";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const BASE_URL = "https://pronostics-footballistiques-mcp.onrender.com";
const API_FOOTBALL_URL = "https://v3.football.api-sports.io";
const FOOTBALL_DATA_URL = "https://api.football-data.org/v4";
const TIMEOUT_MS = 15000;

type JsonObject = Record<string, any>;

type McpSession = {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
};

const sessions = new Map<string, McpSession>();

// --------------------------------------------------
// DOCUMENTS DE DÉCOUVERTE
// --------------------------------------------------

const serverCard = {
  $schema:
    "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
  name: "com.onrender.pronostics-footballistiques-mcp/mcp",
  version: "1.0.0",
  description:
    "Serveur privé d'analyse statistique et de pronostics footballistiques.",
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

function discoveryHeaders(contentType: string) {
  return {
    "Content-Type": contentType,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET",
    "Access-Control-Allow-Headers": "Content-Type, If-None-Match",
    "Access-Control-Expose-Headers": "ETag",
    "Cache-Control": "public, max-age=3600"
  };
}

app.get("/mcp/server-card", (_req, res) => {
  res
    .status(200)
    .set(discoveryHeaders("application/mcp-server-card+json"))
    .json(serverCard);
});

app.get("/.well-known/mcp/server-card.json", (_req, res) => {
  res
    .status(200)
    .set(discoveryHeaders("application/mcp-server-card+json"))
    .json(serverCard);
});

app.get("/.well-known/ai-catalog.json", (_req, res) => {
  res
    .status(200)
    .set(discoveryHeaders("application/ai-catalog+json"))
    .json(aiCatalog);
});

// --------------------------------------------------
// AUTHENTIFICATION PRIVÉE
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

  const authorization = req.get("authorization") || "";
  const suppliedToken = authorization.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";

  const expected = Buffer.from(expectedToken);
  const supplied = Buffer.from(suppliedToken);

  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  ) {
    res.status(401).json({ error: "Accès non autorisé." });
    return;
  }

  next();
}

app.use("/mcp", requireMcpToken);

// --------------------------------------------------
// OUTILS HTTP ET FOURNISSEURS
// --------------------------------------------------

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

function cleanError(error: unknown): string {
  return error instanceof Error ? error.message : "Erreur inconnue";
}

async function fetchJson(
  url: string,
  headers: Record<string, string>
): Promise<JsonObject> {
  const response = await fetch(url, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });

  const text = await response.text();

  let data: JsonObject;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Réponse non JSON : HTTP ${response.status}`);
  }

  if (!response.ok) {
    const message =
      data.message ||
      data.error ||
      `Erreur HTTP ${response.status}`;

    throw new Error(String(message));
  }

  return data;
}

function buildUrl(
  base: string,
  endpoint: string,
  params: Record<string, string | number | undefined>
): string {
  const url = new URL(`${base}${endpoint}`);

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  return url.toString();
}

async function apiFootball(
  endpoint: string,
  params: Record<string, string | number | undefined> = {}
): Promise<JsonObject> {
  const key = process.env.API_FOOTBALL_KEY;

  if (!key) {
    throw new Error("Clé API-Football non configurée.");
  }

  const url = buildUrl(API_FOOTBALL_URL, endpoint, params);

  const data = await fetchJson(url, {
    "x-apisports-key": key
  });

  if (data.errors && Object.keys(data.errors).length > 0) {
    throw new Error(
      `API-Football : ${JSON.stringify(data.errors)}`
    );
  }

  return data;
}

async function footballData(
  endpoint: string,
  params: Record<string, string | number | undefined> = {}
): Promise<JsonObject> {
  const token = process.env.FOOTBALL_DATA_TOKEN;

  if (!token) {
    throw new Error("Jeton football-data.org non configuré.");
  }

  const url = buildUrl(FOOTBALL_DATA_URL, endpoint, params);

  return fetchJson(url, {
    "X-Auth-Token": token
  });
}

// --------------------------------------------------
// NORMALISATION DES MATCHS
// --------------------------------------------------

function normalizeApiFootball(match: JsonObject) {
  const fixture = match.fixture || {};
  const teams = match.teams || {};
  const goals = match.goals || {};
  const league = match.league || {};

  return {
    source: "API-Football",
    sourceId: fixture.id,
    date: fixture.date,
    timestamp: fixture.timestamp,
    status: fixture.status?.short,
    competition: league.name,
    country: league.country,
    home: teams.home?.name,
    away: teams.away?.name,
    homeId: teams.home?.id,
    awayId: teams.away?.id,
    homeGoals: goals.home,
    awayGoals: goals.away
  };
}

function normalizeFootballData(match: JsonObject) {
  return {
    source: "football-data.org",
    sourceId: match.id,
    date: match.utcDate,
    timestamp: match.utcDate
      ? Math.floor(new Date(match.utcDate).getTime() / 1000)
      : undefined,
    status: match.status,
    competition: match.competition?.name,
    country: match.area?.name,
    home: match.homeTeam?.name,
    away: match.awayTeam?.name,
    homeId: match.homeTeam?.id,
    awayId: match.awayTeam?.id,
    homeGoals: match.score?.fullTime?.home,
    awayGoals: match.score?.fullTime?.away
  };
}

// --------------------------------------------------
// MODÈLE DE POISSON
// --------------------------------------------------

function poissonProbability(lambda: number, goals: number): number {
  if (lambda <= 0) {
    return goals === 0 ? 1 : 0;
  }

  let factorial = 1;

  for (let i = 2; i <= goals; i++) {
    factorial *= i;
  }

  return (
    Math.exp(-lambda) *
    Math.pow(lambda, goals) /
    factorial
  );
}

function calculatePoisson(lambdaHome: number, lambdaAway: number) {
  const maxGoals = 8;

  const homeProbabilities = Array.from(
    { length: maxGoals + 1 },
    (_, goals) => poissonProbability(lambdaHome, goals)
  );

  const awayProbabilities = Array.from(
    { length: maxGoals + 1 },
    (_, goals) => poissonProbability(lambdaAway, goals)
  );

  let homeWin = 0;
  let draw = 0;
  let awayWin = 0;
  let over15 = 0;
  let over25 = 0;
  let over35 = 0;
  let bothTeamsScore = 0;

  for (let h = 0; h <= maxGoals; h++) {
    for (let a = 0; a <= maxGoals; a++) {
      const probability =
        homeProbabilities[h] * awayProbabilities[a];

      if (h > a) homeWin += probability;
      else if (h === a) draw += probability;
      else awayWin += probability;

      if (h + a >= 2) over15 += probability;
      if (h + a >= 3) over25 += probability;
      if (h + a >= 4) over35 += probability;

      if (h > 0 && a > 0) {
        bothTeamsScore += probability;
      }
    }
  }

  return {
    lambdaHome: Number(lambdaHome.toFixed(3)),
    lambdaAway: Number(lambdaAway.toFixed(3)),
    probabilities: {
      homeWin: Number((homeWin * 100).toFixed(2)),
      draw: Number((draw * 100).toFixed(2)),
      awayWin: Number((awayWin * 100).toFixed(2)),
      over15: Number((over15 * 100).toFixed(2)),
      under15: Number(((1 - over15) * 100).toFixed(2)),
      over25: Number((over25 * 100).toFixed(2)),
      under25: Number(((1 - over25) * 100).toFixed(2)),
      over35: Number((over35 * 100).toFixed(2)),
      under35: Number(((1 - over35) * 100).toFixed(2)),
      bothTeamsScore: Number((bothTeamsScore * 100).toFixed(2)),
      noBothTeamsScore: Number(((1 - bothTeamsScore) * 100).toFixed(2))
    }
  };
}

// --------------------------------------------------
// HISTORIQUE DES ÉQUIPES
// --------------------------------------------------

function extractTeamForm(
  fixtures: JsonObject[],
  teamId: number
) {
  const matches = fixtures
    .filter((item) => {
      const status = item.fixture?.status?.short;
      return status === "FT" || status === "AET" || status === "PEN";
    })
    .sort(
      (a, b) =>
        (b.fixture?.timestamp || 0) -
        (a.fixture?.timestamp || 0)
    );

  let goalsScored = 0;
  let goalsConceded = 0;
  let wins = 0;
  let draws = 0;
  let losses = 0;
  let homeMatches = 0;
  let awayMatches = 0;

  for (const match of matches) {
    const homeId = match.teams?.home?.id;
    const isHome = homeId === teamId;

    const scored = isHome
      ? match.goals?.home
      : match.goals?.away;

    const conceded = isHome
      ? match.goals?.away
      : match.goals?.home;

    if (
      typeof scored !== "number" ||
      typeof conceded !== "number"
    ) {
      continue;
    }

    goalsScored += scored;
    goalsConceded += conceded;

    if (isHome) homeMatches++;
    else awayMatches++;

    if (scored > conceded) wins++;
    else if (scored === conceded) draws++;
    else losses++;
  }

  const count = wins + draws + losses;

  return {
    matches: count,
    wins,
    draws,
    losses,
    goalsScored,
    goalsConceded,
    averageGoalsScored:
      count ? goalsScored / count : 0,
    averageGoalsConceded:
      count ? goalsConceded / count : 0,
    homeMatches,
    awayMatches,
    form: matches.slice(0, 5).map((match) => {
      const homeId = match.teams?.home?.id;
      const isHome = homeId === teamId;
      const scored = isHome
        ? match.goals?.home
        : match.goals?.away;
      const conceded = isHome
        ? match.goals?.away
        : match.goals?.home;

      return {
        date: match.fixture?.date,
        opponent: isHome
          ? match.teams?.away?.name
          : match.teams?.home?.name,
        venue: isHome ? "Domicile" : "Extérieur",
        score: `${scored}-${conceded}`,
        result:
          scored > conceded
            ? "V"
            : scored === conceded
              ? "N"
              : "D"
      };
    })
  };
}

// --------------------------------------------------
// TESTS RÉELS DES FOURNISSEURS
// --------------------------------------------------

async function testProviders() {
  const date = todayUTC();

  const results = await Promise.allSettled([
    apiFootball("status"),
    footballData("/matches", { date })
  ]);

  const apiResult = results[0];
  const footballResult = results[1];

  return {
    dateUTC: date,
    providers: [
      {
        name: "API-Football",
        configured: Boolean(process.env.API_FOOTBALL_KEY),
        connected: apiResult.status === "fulfilled",
        details:
          apiResult.status === "fulfilled"
            ? {
                account: apiResult.value.response?.account?.firstname
                  ? "Compte reconnu"
                  : "Réponse reçue",
                requests: apiResult.value.response?.requests || null
              }
            : cleanError(apiResult.reason)
      },
      {
        name: "football-data.org",
        configured: Boolean(process.env.FOOTBALL_DATA_TOKEN),
        connected: footballResult.status === "fulfilled",
        details:
          footballResult.status === "fulfilled"
            ? {
                matchesReturned:
                  footballResult.value.matches?.length || 0,
                competitions:
                  footballResult.value.resultSet?.competitions || null
              }
            : cleanError(footballResult.reason)
      }
    ]
  };
}

// --------------------------------------------------
// RÉCUPÉRATION DES MATCHS
// --------------------------------------------------

async function getDailyMatches(
  date: string,
  provider: "all" | "api-football" | "football-data"
) {
  const jobs: Promise<JsonObject>[] = [];
  const names: string[] = [];

  if (
    provider === "all" ||
    provider === "api-football"
  ) {
    jobs.push(apiFootball("fixtures", { date, timezone: "UTC" }));
    names.push("API-Football");
  }

  if (
    provider === "all" ||
    provider === "football-data"
  ) {
    jobs.push(footballData("/matches", { date }));
    names.push("football-data.org");
  }

  const responses = await Promise.allSettled(jobs);

  const matches: JsonObject[] = [];
  const errors: JsonObject[] = [];

  responses.forEach((result, index) => {
    if (result.status === "rejected") {
      errors.push({
        provider: names[index],
        error: cleanError(result.reason)
      });
      return;
    }

    if (names[index] === "API-Football") {
      for (const item of result.value.response || []) {
        matches.push(normalizeApiFootball(item));
      }
    } else {
      for (const item of result.value.matches || []) {
        matches.push(normalizeFootballData(item));
      }
    }
  });

  // Fusion : on conserve les deux sources mais on signale
  // les rencontres potentiellement identiques.
  const seen = new Set<string>();

  const uniqueMatches = matches.filter((match) => {
    const key = [
      String(match.home || "").toLowerCase().trim(),
      String(match.away || "").toLowerCase().trim(),
      String(match.date || "").slice(0, 10)
    ].join("|");

    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  uniqueMatches.sort(
    (a, b) =>
      (a.timestamp || 0) - (b.timestamp || 0)
  );

  return {
    date,
    timezone: "UTC",
    count: uniqueMatches.length,
    sourcesUsed: names,
    errors,
    matches: uniqueMatches
  };
}

// --------------------------------------------------
// ANALYSE COMPLÈTE D'UN MATCH
// --------------------------------------------------

async function analyzeMatch(fixtureId: number) {
  const fixtureData = await apiFootball("fixtures", {
    id: fixtureId,
    timezone: "UTC"
  });

  const fixture = fixtureData.response?.[0];

  if (!fixture) {
    throw new Error(
      `Match ${fixtureId} introuvable dans API-Football.`
    );
  }

  const homeId = fixture.teams?.home?.id;
  const awayId = fixture.teams?.away?.id;

  if (!homeId || !awayId) {
    throw new Error("Identifiants des équipes indisponibles.");
  }

  const [homeHistory, awayHistory, injuries] =
    await Promise.allSettled([
      apiFootball("fixtures", {
        team: homeId,
        last: 10,
        status: "FT",
        timezone: "UTC"
      }),
      apiFootball("fixtures", {
        team: awayId,
        last: 10,
        status: "FT",
        timezone: "UTC"
      }),
      apiFootball("injuries", {
        fixture: fixtureId
      })
    ]);

  if (
    homeHistory.status === "rejected" ||
    awayHistory.status === "rejected"
  ) {
    throw new Error(
      "Impossible de récupérer les derniers résultats des deux équipes."
    );
  }

  const homeForm = extractTeamForm(
    homeHistory.value.response || [],
    homeId
  );

  const awayForm = extractTeamForm(
    awayHistory.value.response || [],
    awayId
  );

  const sufficientData =
    homeForm.matches >= 5 &&
    awayForm.matches >= 5;

  const lambdaHome =
    (homeForm.averageGoalsScored +
      awayForm.averageGoalsConceded) / 2;

  const lambdaAway =
    (awayForm.averageGoalsScored +
      homeForm.averageGoalsConceded) / 2;

  const poisson = calculatePoisson(
    lambdaHome,
    lambdaAway
  );

  const injuriesData =
    injuries.status === "fulfilled"
      ? injuries.value.response || []
      : null;

  const candidates = [
    {
      market: "Plus de 1,5 buts",
      probability: poisson.probabilities.over15
    },
    {
      market: "Moins de 3,5 buts",
      probability: poisson.probabilities.under35
    },
    {
      market: "Plus de 2,5 buts",
      probability: poisson.probabilities.over25
    },
    {
      market: "Les deux équipes marquent",
      probability: poisson.probabilities.bothTeamsScore
    },
    {
      market: "Victoire domicile",
      probability: poisson.probabilities.homeWin
    },
    {
      market: "Match nul",
      probability: poisson.probabilities.draw
    },
    {
      market: "Victoire extérieur",
      probability: poisson.probabilities.awayWin
    }
  ]
    .filter((item) => item.probability >= 65)
    .sort((a, b) => b.probability - a.probability);

  return {
    fixture: {
      id: fixture.fixture.id,
      date: fixture.fixture.date,
      status: fixture.fixture.status?.long,
      competition: fixture.league?.name,
      country: fixture.league?.country,
      home: fixture.teams.home.name,
      away: fixture.teams.away.name
    },
    dataQuality: {
      sufficient: sufficientData,
      homeMatchesAnalyzed: homeForm.matches,
      awayMatchesAnalyzed: awayForm.matches,
      minimumRequired: 5,
      limitations: [
        "Modèle fondé sur les buts des derniers matchs.",
        "Les données xG et les compositions ne sont pas intégrées dans cette première version.",
        "Les probabilités ne constituent pas une garantie de résultat.",
        "Aucune value bet ne peut être confirmée sans cotes de bookmakers."
      ]
    },
    homeForm,
    awayForm,
    injuries: {
      available: injuriesData !== null,
      count: injuriesData?.length ?? null,
      players: injuriesData
    },
    poisson: sufficientData ? poisson : null,
    selections: sufficientData ? candidates : [],
    decision:
      !sufficientData
        ? "ANALYSE INSUFFISANTE : aucune sélection retenue."
        : candidates.length
          ? "Sélections statistiques candidates. Vérifier les cotes et les autres informations avant toute décision."
          : "Aucune sélection ne dépasse le seuil statistique de 65 %."
  };
}

// --------------------------------------------------
// OUTILS MCP
// --------------------------------------------------

function createMcpServer() {
  const server = new McpServer({
    name: "pronostics-footballistiques-mcp",
    version: "2.0.0"
  });

  server.tool(
    "diagnostic_fournisseurs",
    "Teste réellement les connexions API-Football et football-data.org.",
    {},
    async () => {
      const result = await testProviders();

      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    }
  );

  server.tool(
    "tester_api",
    "Effectue un test réel des deux fournisseurs de données.",
    {},
    async () => {
      const result = await testProviders();

      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    }
  );

  server.tool(
    "rechercher_matchs",
    "Recherche les matchs d'une date donnée dans les fournisseurs disponibles.",
    {
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      provider: z.enum([
        "all",
        "api-football",
        "football-data"
      ]).optional()
    },
    async ({ date, provider }) => {
      const result = await getDailyMatches(
        date || todayUTC(),
        provider || "all"
      );

      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    }
  );

  server.tool(
    "analyser_match",
    "Analyse un match avec forme récente, absences disponibles et modèle de Poisson.",
    {
      fixtureId: z.number().int().positive()
    },
    async ({ fixtureId }) => {
      const result = await analyzeMatch(fixtureId);

      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    }
  );

  server.tool(
    "presentation",
    "Présente les capacités et limites du moteur de pronostics.",
    {},
    async () => ({
      content: [{
        type: "text",
        text:
          "Pronostics Footballistiques Mathématiques v2.0. " +
          "Outils disponibles : tester_api, diagnostic_fournisseurs, " +
          "rechercher_matchs et analyser_match. " +
          "Les sélections sont filtrées selon les données disponibles. " +
          "Les cotes et la value bet ne sont pas encore intégrées."
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
    version: "2.0.0",
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
        error:
          "Session MCP inconnue. Initialisez une nouvelle session."
      });
      return;
    }

    await session.transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("Erreur MCP :", cleanError(error));

    if (!res.headersSent) {
      res.status(500).json({
        error: "Erreur interne du serveur MCP."
      });
    }
  }
});

app.get("/mcp", (_req, res) => {
  res.status(405).json({
    error: "Utilisez le transport MCP Streamable HTTP."
  });
});

app.delete("/mcp", async (req, res) => {
  const sessionId =
    req.headers["mcp-session-id"] as string | undefined;

  const session = sessionId
    ? sessions.get(sessionId)
    : undefined;

  if (!session) {
    res.status(404).json({ error: "Session introuvable." });
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
    `Serveur MCP Pronostics Footballistiques v2.0 démarré sur le port ${port}`
  );
});
