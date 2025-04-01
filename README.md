# Eliza Leaderboard

A modern analytics pipeline for tracking and analyzing GitHub contributions. The system processes contributor data, generates AI-powered summaries, and maintains a leaderboard of developer activity.

## Features

- Tracks pull requests, issues, reviews, and comments
- Calculates contributor scores based on activity and impact
- Generates AI-powered summaries of contributions
- Exports daily summaries to JSON files
- Maintains contributor expertise levels and focus areas

## Setup

1. Install dependencies:
```bash
bun install
```

2. Set up environment variables in `.envrc` or `.env`:
```bash
# Required for AI summaries
OPENROUTER_API_KEY=your_api_key_here

# Optional site info
SITE_URL=https://elizaos.github.io
SITE_NAME="GitHub Contributor Analytics"
```

3. Configure repositories in `config/pipeline.config.ts`:
```typescript
repositories: [
  {
    owner: "elizaos",
    name: "eliza",
    defaultBranch: "v2-develop",
  }
],
```

## Usage

The pipeline provides several commands for different operations:

```bash
# Initialize the database and load configuration
bun run pipeline init

# List all tracked repositories
bun run pipeline list-repos

# Fetch latest data from GitHub
bun run pipeline fetch

# Process and analyze the data
bun run pipeline process

# Run the complete pipeline (fetch and process)
bun run pipeline run
```

### Command Details

- `init`: Sets up the database and loads initial configuration
- `list-repos`: Shows all repositories currently being tracked
- `fetch`: Downloads the latest contributor data from GitHub
- `process`: Analyzes the data, generates summaries, and calculates scores
- `run`: Convenience command that runs both `fetch` and `process`

### Output Files

The pipeline generates several output files:
- Latest summary: `data/daily/summary.json`
- Historical summaries: `data/daily/history/summary_YYYY_MM_DD.json`

## Development

- Run linting: `bun run lint`
- Type checking: `bunx tsc --noEmit`
- Run all checks: `bun run check`
- Generate database types: `bun run db:generate`

## Configuration

The pipeline behavior can be customized in `config/pipeline.config.ts`:

- `lookbackDays`: Number of days to analyze (default: 14)
- `botUsers`: List of bot usernames to ignore
- `scoring`: Configure point values for different contribution types
- `tags`: Define expertise areas and their scoring weights
- `aiSummary`: Configure AI summary generation settings
