import fs from "fs";
import path from "path";
import { db } from "./db";
import { userDailySummaries, userStats } from "./schema";
import { desc, sql } from "drizzle-orm";
import { DailySummary } from "@/lib/get-daily-summaries";
import { normalizeDate } from "@/lib/date-utils";

/**
 * Service for exporting database summaries to JSON files
 */
export class ExportService {
  private dataDir: string;

  constructor() {
    this.dataDir = path.join(process.cwd(), "data/daily");
    this.ensureDirectories();
  }

  /**
   * Export daily summary to JSON files
   */
  async exportDailySummary(date: string): Promise<void> {
    // Get all summaries for the date
    const summaries = await db
      .select()
      .from(userDailySummaries)
      .where(sql`date = ${date}`)
      .orderBy(desc(userDailySummaries.score));

    if (summaries.length === 0) {
      console.warn(`No summaries found for date ${date}`);
      return;
    }

    // Calculate aggregate metrics
    const metrics = {
      contributors: summaries.length,
      merged_prs: summaries.reduce((acc, s) => acc + s.totalPRs, 0),
      new_issues: 0, // TODO: Calculate from issues data
      lines_changed: summaries.reduce(
        (acc, s) => acc + s.additions + s.deletions,
        0
      ),
    };

    // Get top contributors
    const topContributors = await Promise.all(
      summaries.slice(0, 3).map(async (summary) => {
        const stats = await db
          .select()
          .from(userStats)
          .where(sql`username = ${summary.username}`)
          .limit(1);

        const areas = stats[0]?.focusAreas
          ? (JSON.parse(stats[0].focusAreas) as [string, number][])
              .map(([area]) => area)
              .slice(0, 3)
          : [];

        return {
          name: summary.username || "unknown",
          summary: summary.summary || `${summary.username} made various contributions`,
          areas,
        };
      })
    );

    // Build the daily summary
    const dailySummary: DailySummary = {
      title: `elizaos Eliza (${date})`,
      version: "", // TODO: Get from config/git
      overview: this.generateOverview(summaries),
      metrics,
      changes: {
        features: [],
        fixes: [],
        chores: [],
      },
      areas: this.calculateAreaChanges(summaries),
      issues_summary: "",
      questions: [],
      top_contributors: topContributors,
    };

    // Save to both current and history
    const normalizedDate = normalizeDate(date);
    await this.saveToFile(
      path.join(this.dataDir, "summary.json"),
      dailySummary
    );
    await this.saveToFile(
      path.join(this.dataDir, "history", `summary_${normalizedDate}.json`),
      dailySummary
    );
  }

  /**
   * Generate overview text from summaries
   */
  private generateOverview(summaries: any[]): string {
    const totalPRs = summaries.reduce((acc, s) => acc + s.totalPRs, 0);
    const contributors = summaries.length;

    let overview = `Development activity with ${contributors} contributors `;
    overview += `merging ${totalPRs} PRs. `;

    if (summaries[0]?.summary) {
      overview += `Major work included ${summaries[0].summary}`;
    }

    return overview;
  }

  /**
   * Calculate changes by area
   */
  private calculateAreaChanges(summaries: any[]): Array<{
    name: string;
    files: number;
    additions: number;
    deletions: number;
  }> {
    const areas = new Map<
      string,
      { files: number; additions: number; deletions: number }
    >();

    summaries.forEach((summary) => {
      const stats = summary.focusAreas
        ? (JSON.parse(summary.focusAreas) as [string, number][])
        : [];
      stats.forEach(([area, count]) => {
        const current = areas.get(area) || {
          files: 0,
          additions: 0,
          deletions: 0,
        };
        areas.set(area, {
          files: current.files + summary.changedFiles,
          additions: current.additions + summary.additions,
          deletions: current.deletions + summary.deletions,
        });
      });
    });

    return Array.from(areas.entries()).map(([name, stats]) => ({
      name,
      ...stats,
    }));
  }

  /**
   * Save data to JSON file
   */
  private async saveToFile(filepath: string, data: any): Promise<void> {
    await fs.promises.writeFile(
      filepath,
      JSON.stringify(data, null, 2),
      "utf8"
    );
  }

  /**
   * Ensure required directories exist
   */
  private ensureDirectories(): void {
    const dirs = [
      this.dataDir,
      path.join(this.dataDir, "history"),
    ];

    dirs.forEach((dir) => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });
  }
} 