import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { db } from "@/lib/data/db";
import {
  QueryParams,
  buildCommonWhereConditions,
} from "@/lib/pipelines/queryHelpers";
import {
  issueComments,
  prReviews,
  rawCommits,
  rawIssues,
  rawPullRequestFiles,
  rawPullRequests,
  users,
} from "@/lib/data/schema";
import { buildAreaMap } from "@/lib/pipelines/codeAreaHelpers";
import { categorizeWorkItem } from "@/lib/pipelines/codeAreaHelpers";

/**
 * Get top pull requests for a repository in a time period
 */

export async function getTopPullRequests(params: QueryParams = {}, limit = 5) {
  const whereConditions = buildCommonWhereConditions(params, rawPullRequests, [
    "createdAt",
    "mergedAt",
    "closedAt",
  ]);

  const prs = await db
    .select({
      id: rawPullRequests.id,
      title: rawPullRequests.title,
      author: rawPullRequests.author,
      number: rawPullRequests.number,
      repository: rawPullRequests.repository,
      createdAt: rawPullRequests.createdAt,
      mergedAt: rawPullRequests.mergedAt,
      additions: rawPullRequests.additions,
      deletions: rawPullRequests.deletions,
    })
    .from(rawPullRequests)
    .where(and(...whereConditions))
    .orderBy(desc(rawPullRequests.additions))
    .limit(limit)
    .all();

  return prs;
} /**
 * Get top issues for a repository in a time period
 */

export async function getTopIssues(params: QueryParams = {}, limit = 5) {
  const whereConditions = [
    // Include issues that are either:
    // 1. Currently open, or
    // 2. Were closed after the end date (meaning they were open during the period)
    params.dateRange
      ? sql`(${rawIssues.state} = 'OPEN' OR ${rawIssues.closedAt} > ${params.dateRange.endDate})`
      : sql`${rawIssues.state} = 'OPEN'`,
    ...buildCommonWhereConditions(params, rawIssues, [
      "createdAt",
      "updatedAt",
      "closedAt",
    ]),
  ];

  // Create a comment count subquery
  const commentCountQuery = db.$with("comment_counts").as(
    db
      .select({
        issueId: issueComments.issueId,
        count: sql<number>`COUNT(*)`.as("comment_count"),
      })
      .from(issueComments)
      .where(
        params.dateRange
          ? sql`${issueComments.createdAt} >= ${params.dateRange.startDate} AND ${issueComments.createdAt} <= ${params.dateRange.endDate}`
          : undefined,
      )
      .groupBy(issueComments.issueId),
  );

  // Get all issues with their comment counts
  const issuesWithComments = await db
    .with(commentCountQuery)
    .select({
      id: rawIssues.id,
      title: rawIssues.title,
      author: rawIssues.author,
      number: rawIssues.number,
      repository: rawIssues.repository,
      createdAt: rawIssues.createdAt,
      closedAt: rawIssues.closedAt,
      state: rawIssues.state,
      commentCount: sql<number>`COALESCE(comment_counts.comment_count, 0)`,
    })
    .from(rawIssues)
    .leftJoin(commentCountQuery, eq(commentCountQuery.issueId, rawIssues.id))
    .where(and(...whereConditions))
    .orderBy(desc(sql`COALESCE(comment_counts.comment_count, 0)`))
    .limit(limit)
    .all();

  return issuesWithComments;
} /**
 * Get top contributors ranked by activity score
 */

export async function getTopContributors(params: QueryParams = {}, limit = 5) {
  const { repository } = params;

  try {
    // Build conditions for each table
    const prConditions = buildCommonWhereConditions(params, rawPullRequests, [
      "createdAt",
      "mergedAt",
    ]);
    const issueConditions = buildCommonWhereConditions(params, rawIssues, [
      "createdAt",
    ]);
    const reviewConditions = buildCommonWhereConditions(
      { ...params, repository: undefined }, // Handle repository separately for reviews
      prReviews,
      ["createdAt"],
    );

    // Additional repository condition for reviews (needs to join with PRs)
    const reviewRepoCondition = repository
      ? sql`EXISTS (
          SELECT 1 FROM ${rawPullRequests} 
          WHERE ${rawPullRequests.id} = ${prReviews.prId}
          AND ${rawPullRequests.repository} = ${repository}
        )`
      : undefined;

    // Get users with PR counts
    const userPrCounts = await db
      .select({
        username: users.username,
        count: sql<number>`count(*)`.as("count"),
      })
      .from(users)
      .innerJoin(rawPullRequests, eq(users.username, rawPullRequests.author))
      .where(and(eq(users.isBot, 0), ...prConditions))
      .groupBy(users.username);

    // Get users with issue counts
    const userIssueCounts = await db
      .select({
        username: users.username,
        count: sql<number>`count(*)`.as("count"),
      })
      .from(users)
      .innerJoin(rawIssues, eq(users.username, rawIssues.author))
      .where(and(eq(users.isBot, 0), ...issueConditions))
      .groupBy(users.username);

    // Get users with review counts
    const userReviewCounts = await db
      .select({
        username: users.username,
        count: sql<number>`count(*)`.as("count"),
      })
      .from(users)
      .innerJoin(prReviews, eq(users.username, prReviews.author))
      .where(
        and(
          eq(users.isBot, 0),
          ...(reviewRepoCondition
            ? [...reviewConditions, reviewRepoCondition]
            : reviewConditions),
        ),
      )
      .groupBy(users.username);

    // Create maps for each activity type
    const prCountMap = new Map(userPrCounts.map((u) => [u.username, u.count]));
    const issueCountMap = new Map(
      userIssueCounts.map((u) => [u.username, u.count]),
    );
    const reviewCountMap = new Map(
      userReviewCounts.map((u) => [u.username, u.count]),
    );

    // Get all unique usernames with activity
    const allUsernames = new Set([
      ...userPrCounts.map((u) => u.username),
      ...userIssueCounts.map((u) => u.username),
      ...userReviewCounts.map((u) => u.username),
    ]);

    // Create combined scores
    const contributorScores = Array.from(allUsernames).map((username) => ({
      username,
      pr_count: prCountMap.get(username) || 0,
      issue_count: issueCountMap.get(username) || 0,
      review_count: reviewCountMap.get(username) || 0,
    }));

    // Sort by total score and limit
    return contributorScores
      .sort(
        (a, b) =>
          b.pr_count +
          b.issue_count +
          b.review_count -
          (a.pr_count + a.issue_count + a.review_count),
      )
      .slice(0, limit);
  } catch (error) {
    console.error(`Error in getTopContributors:`, error);
    return [];
  }
} /**
 * Get project metrics for a specific time interval
 */

export async function getRepositoryMetrics({
  repository,
  dateRange,
}: {
  repository: string;
  dateRange?: {
    startDate: string;
    endDate: string;
  };
}) {
  // Get PRs created in this period
  const createdPRs = await db.query.rawPullRequests.findMany({
    where: and(
      eq(rawPullRequests.repository, repository),
      ...(dateRange
        ? [
            gte(rawPullRequests.createdAt, dateRange.startDate),
            lte(rawPullRequests.createdAt, dateRange.endDate),
          ]
        : []),
    ),
  });

  // Get PRs merged in this period
  const mergedPRsThisPeriod = await db.query.rawPullRequests.findMany({
    where: and(
      eq(rawPullRequests.repository, repository),
      ...(dateRange
        ? [
            gte(rawPullRequests.mergedAt, dateRange.startDate),
            lte(rawPullRequests.mergedAt, dateRange.endDate),
          ]
        : []),
    ),
  });

  const pullRequests = {
    newPRs: createdPRs,
    mergedPRs: mergedPRsThisPeriod,
  };

  // Get issues created in this period
  const newIssues = await db.query.rawIssues.findMany({
    where: and(
      eq(rawIssues.repository, repository),
      ...(dateRange
        ? [
            gte(rawIssues.createdAt, dateRange.startDate),
            lte(rawIssues.createdAt, dateRange.endDate),
          ]
        : []),
    ),
  });

  // Get issues closed in this period
  const closedIssues = await db.query.rawIssues.findMany({
    where: and(
      eq(rawIssues.repository, repository),
      ...(dateRange
        ? [
            gte(rawIssues.closedAt, dateRange.startDate),
            lte(rawIssues.closedAt, dateRange.endDate),
          ]
        : []),
    ),
  });

  const issues = {
    newIssues,
    closedIssues,
  };

  // Get active contributors
  const activeContributors = await getActiveContributors({
    repository,
    dateRange: dateRange || { startDate: "1970-01-01", endDate: "2100-01-01" },
  });

  const uniqueContributors = activeContributors.length;

  // Get all commits in the time period
  const commits = await db.query.rawCommits.findMany({
    where: and(
      eq(rawCommits.repository, repository),
      ...(dateRange
        ? [
            gte(rawCommits.committedDate, dateRange.startDate),
            lte(rawCommits.committedDate, dateRange.endDate),
          ]
        : []),
    ),
  });

  const filesChangedThisPeriod = await db
    .selectDistinct({ path: rawPullRequestFiles.path })
    .from(rawPullRequestFiles)
    .where(
      inArray(
        rawPullRequestFiles.prId,
        mergedPRsThisPeriod.map((pr) => pr.id),
      ),
    );

  const topContributors = await getTopContributors({
    repository,
    dateRange,
  });
  // Calculate code changes
  const additions = commits.reduce(
    (sum, commit) => sum + (commit.additions || 0),
    0,
  );
  const deletions = commits.reduce(
    (sum, commit) => sum + (commit.deletions || 0),
    0,
  );

  const codeChanges = {
    additions,
    deletions,
    files: filesChangedThisPeriod.length,
    commitCount: commits.length,
  };

  // Get PR files for merged PRs in this period
  const prFiles = await db.query.rawPullRequestFiles.findMany({
    where: inArray(
      rawPullRequestFiles.prId,
      mergedPRsThisPeriod.map((pr) => pr.id),
    ),
  });

  // Get focus areas from PR files
  const areaMap = buildAreaMap(prFiles);

  const focusAreas = Array.from(areaMap.entries())
    .map(([area, count]) => ({ area, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // Get completed items (PRs merged in this period)
  const completedItems = mergedPRsThisPeriod.map((pr) => ({
    title: pr.title,
    prNumber: pr.number,
    type: categorizeWorkItem(pr.title),
  }));

  return {
    repository,
    pullRequests,
    issues,
    uniqueContributors,
    topContributors,
    codeChanges,
    focusAreas,
    completedItems,
  };
}
export type RepositoryMetrics = Awaited<
  ReturnType<typeof getRepositoryMetrics>
>; /**
 * Get all active contributors in a repository within a time range
 */

export async function getActiveContributors({
  repository,
  dateRange,
}: {
  repository: string;
  dateRange: {
    startDate: string;
    endDate: string;
  };
}) {
  // Find contributors with any activity in the time range
  const activeUsernames = new Set<string>();

  // PRs
  const prAuthors = await db
    .select({ author: rawPullRequests.author })
    .from(rawPullRequests)
    .where(
      and(
        eq(rawPullRequests.repository, repository),
        gte(rawPullRequests.createdAt, dateRange.startDate),
        lte(rawPullRequests.createdAt, dateRange.endDate),
      ),
    );

  prAuthors.forEach((author) => {
    if (author.author) activeUsernames.add(author.author);
  });

  // Issues
  const issueAuthors = await db
    .select({ author: rawIssues.author })
    .from(rawIssues)
    .where(
      and(
        eq(rawIssues.repository, repository),
        gte(rawIssues.createdAt, dateRange.startDate),
        lte(rawIssues.createdAt, dateRange.endDate),
      ),
    );

  issueAuthors.forEach((author) => {
    if (author.author) activeUsernames.add(author.author);
  });

  // Reviews
  const reviewers = await db
    .select({ author: prReviews.author })
    .from(prReviews)
    .innerJoin(rawPullRequests, eq(prReviews.prId, rawPullRequests.id))
    .where(
      and(
        eq(rawPullRequests.repository, repository),
        gte(prReviews.createdAt, dateRange.startDate),
        lte(prReviews.createdAt, dateRange.endDate),
      ),
    );

  reviewers.forEach((reviewer) => {
    if (reviewer.author) activeUsernames.add(reviewer.author);
  });

  // Commits
  const committers = await db
    .select({ author: rawCommits.author })
    .from(rawCommits)
    .where(
      and(
        eq(rawCommits.repository, repository),
        gte(rawCommits.committedDate, dateRange.startDate),
        lte(rawCommits.committedDate, dateRange.endDate),
      ),
    );

  committers.forEach((committer) => {
    if (committer.author) activeUsernames.add(committer.author);
  });

  // Get contributor details
  const activeContributors = await db
    .select()
    .from(users)
    .where(
      activeUsernames.size > 0
        ? inArray(users.username, Array.from(activeUsernames))
        : undefined,
    );

  return activeContributors;
}
