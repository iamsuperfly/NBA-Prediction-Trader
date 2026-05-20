import { config } from "../config.js";
import type { NBAGame, NBATeam, NBAStandings } from "../types.js";

async function fetchJson<T>(url: string, headers?: Record<string, string>): Promise<T> {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`NBA API ${res.status}: ${url}`);
  return res.json() as Promise<T>;
}

export async function getPlayoffGames(): Promise<NBAGame[]> {
  const today = new Date().toISOString().split("T")[0]!;
  const url = `${config.nba.espnApi}/scoreboard?dates=${today.replace(/-/g, "")}`;

  try {
    const data = await fetchJson<any>(url);
    const events: any[] = data.events ?? [];

    return events.map((e: any) => {
      const comps = e.competitions?.[0];
      const home = comps?.competitors?.find((c: any) => c.homeAway === "home");
      const away = comps?.competitors?.find((c: any) => c.homeAway === "away");
      const status = e.status?.type?.name ?? "STATUS_SCHEDULED";

      return {
        id: Number(e.id),
        date: e.date,
        homeTeam: teamFromEspn(home?.team, home?.records),
        awayTeam: teamFromEspn(away?.team, away?.records),
        homeScore: home?.score ? Number(home.score) : undefined,
        awayScore: away?.score ? Number(away.score) : undefined,
        status: espnStatus(status),
        period: comps?.status?.period,
        time: comps?.status?.displayClock,
      } satisfies NBAGame;
    });
  } catch (err) {
    console.error("[nba-client] ESPN scoreboard error:", err);
    return [];
  }
}

export async function getPlayoffStandings(): Promise<NBAStandings[]> {
  const url = `${config.nba.espnApi}/standings`;
  try {
    const data = await fetchJson<any>(url);
    const entries: any[] = data.children?.flatMap((conf: any) =>
      conf.standings?.entries ?? []
    ) ?? [];

    return entries.map((e: any) => {
      const stats: any[] = e.stats ?? [];
      const wins = Number(stats.find((s: any) => s.name === "wins")?.value ?? 0);
      const losses = Number(stats.find((s: any) => s.name === "losses")?.value ?? 0);
      const seed = Number(stats.find((s: any) => s.name === "playoffSeed")?.value ?? 99);

      return {
        team: {
          id: Number(e.team?.id ?? 0),
          name: e.team?.name ?? "",
          fullName: e.team?.displayName ?? "",
          abbreviation: e.team?.abbreviation ?? "",
          wins,
          losses,
          winPct: wins + losses > 0 ? wins / (wins + losses) : 0,
        },
        conference: "East" as const,
        seed,
        playoffBound: seed <= 8,
      };
    });
  } catch (err) {
    console.error("[nba-client] standings error:", err);
    return [];
  }
}

export async function getTeamRecentForm(teamAbbr: string): Promise<{
  last5Wins: number;
  last10Wins: number;
  homeWinPct: number;
  awayWinPct: number;
}> {
  try {
    const url = `${config.nba.espnApi}/teams/${teamAbbr}/schedule?season=2025`;
    const data = await fetchJson<any>(url);
    const events: any[] = data.events ?? [];

    const completed = events.filter((e: any) => e.competitions?.[0]?.status?.type?.completed);
    const last10 = completed.slice(-10);
    const last5 = completed.slice(-5);

    const countWins = (games: any[]) =>
      games.filter((e: any) => {
        const comp = e.competitions?.[0];
        const teamComp = comp?.competitors?.find(
          (c: any) => c.team?.abbreviation?.toUpperCase() === teamAbbr.toUpperCase()
        );
        return teamComp?.winner === true;
      }).length;

    const homeGames = last10.filter((e: any) =>
      e.competitions?.[0]?.competitors?.find(
        (c: any) => c.team?.abbreviation?.toUpperCase() === teamAbbr.toUpperCase() && c.homeAway === "home"
      )
    );
    const awayGames = last10.filter((e: any) =>
      e.competitions?.[0]?.competitors?.find(
        (c: any) => c.team?.abbreviation?.toUpperCase() === teamAbbr.toUpperCase() && c.homeAway === "away"
      )
    );

    return {
      last5Wins: countWins(last5),
      last10Wins: countWins(last10),
      homeWinPct: homeGames.length > 0 ? countWins(homeGames) / homeGames.length : 0.5,
      awayWinPct: awayGames.length > 0 ? countWins(awayGames) / awayGames.length : 0.5,
    };
  } catch {
    return { last5Wins: 2, last10Wins: 5, homeWinPct: 0.5, awayWinPct: 0.5 };
  }
}

function teamFromEspn(team: any, records: any): NBATeam {
  const overall = Array.isArray(records)
    ? records.find((r: any) => r.name === "overall" || r.type === "total")
    : null;
  const [wins, losses] = (overall?.summary ?? "0-0").split("-").map(Number);
  const w = wins ?? 0;
  const l = losses ?? 0;
  return {
    id: Number(team?.id ?? 0),
    name: team?.name ?? "Unknown",
    fullName: team?.displayName ?? "Unknown",
    abbreviation: team?.abbreviation ?? "UNK",
    wins: w,
    losses: l,
    winPct: w + l > 0 ? w / (w + l) : 0.5,
  };
}

function espnStatus(s: string): NBAGame["status"] {
  if (s.includes("FINAL") || s.includes("COMPLETE")) return "final";
  if (s.includes("IN_PROGRESS") || s.includes("HALFTIME")) return "in_progress";
  return "scheduled";
}
