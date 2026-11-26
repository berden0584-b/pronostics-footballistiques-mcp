# Pronostics Footballistiques Mathématiques

Serveur MCP dédié à l'analyse statistique des matchs de football et à l'évaluation mathématique des pronostics.

## Objectif

Fournir des analyses fondées sur des données vérifiables afin d'identifier uniquement les sélections statistiquement défendables.

Le moteur privilégie la fiabilité des données plutôt que la quantité de pronostics.

## Fonctionnalités prévues

- Recherche de matchs et de compétitions.
- Analyse de la forme récente des équipes.
- Comparaison des performances à domicile et à l'extérieur.
- Analyse statistique des buts.
- Modélisation probabiliste avec la loi de Poisson.
- Évaluation des probabilités et de la valeur des cotes.
- Analyse des tirs et tirs cadrés lorsque les données sont disponibles.
- Vérification des absences et compositions lorsque les fournisseurs les renseignent.
- Filtrage des sélections selon des critères de qualité.

## Fournisseurs de données

Les intégrations prévues comprennent :

- API-Football
- football-data.org

La disponibilité des statistiques dépend de la couverture de chaque fournisseur et de son abonnement.

Aucune statistique manquante ne doit être inventée.

## Technologies

- Node.js
- TypeScript
- Model Context Protocol (MCP)
- Express
- Zod

## Configuration

Les variables d'environnement sont documentées dans `.env.example`.

Les véritables clés API doivent rester confidentielles et ne jamais être publiées dans le dépôt GitHub.

## Installation locale

```bash
npm install
npm run typecheck
npm run build
npm start
```

## Endpoints

- `/health` : contrôle de disponibilité du serveur.
- `/mcp` : endpoint du protocole MCP.

## Principes d'analyse

1. Utiliser des données vérifiables.
2. Distinguer les données disponibles des données manquantes.
3. Ne pas inventer les absences, les cotes ou les statistiques.
4. Calculer les probabilités à partir des données réellement disponibles.
5. Écarter les pronostics insuffisamment justifiés.

## État du projet

Projet en cours de développement. Les fonctionnalités annoncées comme prévues ne sont pas nécessairement déjà opérationnelles.

## Avertissement

Les probabilités et pronostics sont des estimations statistiques, jamais des garanties de résultat. Les paris sportifs comportent un risque de perte financière.
Projet en développement
