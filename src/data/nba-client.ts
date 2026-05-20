import { config } from "../config.js";
import type { NBAGame, NBATeam, NBAStandings, TeamForm, InjuryReport, InjuredPlayer, SeriesState } from "../types.js";

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { "User-Agent": "NBA-Prediction-Trader/1.0" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`ESPN API ${res.status}: ${url}`);
  return res.json() as Promise<T>;
}

export async function getPlayoffGames(): Promise<NBAGame[]> {
  const today = new Date().toISOString().split("T")[0]!;
  const dateStr = today.replace(/-/g, "");
  const url = `${config.nba.espnApi}/scoreboard?dates=${dateStr}`;

  try {
    const data = await fetchJson<any>(url);
    const events: any[] = data.events ?? [];
    return events.map(parseEspnEvent).filter(Boolean) as NBAGame[];
  } catch (err) {
    console.error("[nba-client] scoreboard error:", (err as Error).message);
    return [];
  }
}

export async function getPlayoffStandings(): Promise<NBAStandings[]> {
  try {
    const data = await fetchJson<any>(`${config.nba.espnApi}/standings?season=2025&seasontype=3`);
    const entries: any[] = data.children?.flatMap((conf: any) =>
      conf.standings?.entries ?? []
    ) ?? [];

    return entries.map((e: any) => {
      const stats: any[] = e.stats ?? [];
      const wins = Number(stats.find((s: any) => s.name === "wins")?.value ?? 0);
      const losses = Number(stats.find((s: any) => s.name === "losses")?.value ?? 0);
      const seed = Number(stats.find((s: any) => s.name === "playoffSeed")?.value ?? 99);
      const confName: string = e.team?.conferenceId ?? "";

      return {
        team: {
          id: Number(e.team?.id ?? 0),
          name: e.team?.name ?? "",
          fullName: e.team?.displayName ?? "",
          abbreviation: e.team?.abbreviation ?? "",
          wins,
          losses,
          winPct: wins + losses > 0 ? wins / (wins + losses) : 0.5,
        },
        conference: confName.toLowerCase().includes("east") ? "East" as const : "West" as const,
        seed,
        playoffBound: seed <= 8,
      } satisfies NBAStandings;
    });
  } catch (err) {
    console.error("[nba-client] standings error:", (err as Error).message);
    return [];
  }
}

export async function getTeamForm(teamAbbr: string): Promise<TeamForm> {
  try {
    const data = await fetchJson<any>(
      `${config.nba.espnApi}/teams/${teamAbbr}/schedule?season=2025&seasontype=3`
    );
    const events: any[] = data.events ?? [];
    const completed = events.filter(
      (e: any) => e.competitions?.[0]?.status?.type?.completed === true
    );

    const last10 = completed.slice(-10);
    const last5 = completed.slice(-5);

    const isWin = (e: any) => {
      const comp = e.competitions?.[0];
      const t = comp?.competitors?.find(
        (c: any) => c.team?.abbreviation?.toUpperCase() === teamAbbr.toUpperCase()
      );
      return t?.winner === true;
    };

    const isHome = (e: any) =>
      e.competitions?.[0]?.competitors?.some(
        (c: any) =>
          c.team?.abbreviation?.toUpperCase() === teamAbbr.toUpperCase() &&
          c.homeAway === "home"
      ) ?? false;

    const homeGames = last10.filter(isHome);
    const awayGames = last10.filter((e: any) => !isHome(e));

    const pointDiffs = last5.map((e: any) => {
      const comp = e.competitions?.[0];
      const team = comp?.competitors?.find(
        (c: any) => c.team?.abbreviation?.toUpperCase() === teamAbbr.toUpperCase()
      );
      const opp = comp?.competitors?.find(
        (c: any) => c.team?.abbreviation?.toUpperCase() !== teamAbbr.toUpperCase()
      );
      return (Number(team?.score ?? 0) - Number(opp?.score ?? 0));
    });

    const avgPointDiff =
      pointDiffs.length > 0
        ? pointDiffs.reduce((a, b) => a + b, 0) / pointDiffs.length
        : 0;

    return {
      last5Wins: last5.filter(isWin).length,
      last10Wins: last10.filter(isWin).length,
      homeWinPct: homeGames.length > 0 ? homeGames.filter(isWin).length / homeGames.length : 0.5,
      awayWinPct: awayGames.length > 0 ? awayGames.filter(isWin).length / awayGames.length : 0.5,
      last5PointDiff: avgPointDiff,
    };
  } catch {
    return { last5Wins: 2, last10Wins: 5, homeWinPct: 0.5, awayWinPct: 0.5, last5PointDiff: 0 };
  }
}

export async function getInjuryReports(): Promise<Map<string, InjuryReport>> {
  const reports = new Map<string, InjuryReport>();
  try {
    const data = await fetchJson<any>(`${config.nba.espnApi}/injuries`);
    const teams: any[] = data.injuries ?? [];

    for (const team of teams) {
      const abbr: string = team.displayName
        ? abbrFromDisplayName(team.displayName)
        : team.abbreviation ?? "";
      if (!abbr) continue;

      const players: InjuredPlayer[] = (team.injuries ?? []).map((inj: any) => {
        const status = normalizeStatus(inj.status ?? inj.type);
        const pos: string = inj.athlete?.position?.abbreviation ?? "?";
        return {
          name: inj.athlete?.displayName ?? "Unknown",
          status,
          position: pos,
          impactWeight: positionImpact(pos, status),
        } satisfies InjuredPlayer;
      });

      const impactScore = players.reduce((sum, p) => sum + p.impactWeight, 0);
      reports.set(abbr.toUpperCase(), { teamAbbr: abbr, players, impactScore });
    }
  } catch (err) {
    console.error("[nba-client] injuries error:", (err as Error).message);
  }
  return reports;
}

export async function getSeriesState(
  team1Abbr: string,
  team2Abbr: string
): Promise<SeriesState | null> {
  try {
    const data = await fetchJson<any>(
      `${config.nba.espnApi}/scoreboard?seasontype=3&limit=50`
    );
    const events: any[] = data.events ?? [];

    let t1Wins = 0;
    let t2Wins = 0;
    let lastWinner: string | null = null;
    let homeTeamWinStreak = 0;

    for (const e of events) {
      const comp = e.competitions?.[0];
      if (!comp?.status?.type?.completed) continue;

      const comps: any[] = comp.competitors ?? [];
      const hasT1 = comps.some(
        (c: any) => c.team?.abbreviation?.toUpperCase() === team1Abbr.toUpperCase()
      );
      const hasT2 = comps.some(
        (c: any) => c.team?.abbreviation?.toUpperCase() === team2Abbr.toUpperCase()
      );
      if (!hasT1 || !hasT2) continue;

      const winner = comps.find((c: any) => c.winner === true);
      if (!winner) continue;

      const winAbbr = winner.team?.abbreviation?.toUpperCase() ?? "";
      if (winAbbr === team1Abbr.toUpperCase()) t1Wins++;
      else t2Wins++;
      lastWinner = winAbbr;

      const homeComp = comps.find((c: any) => c.homeAway === "home");
      const homeAbbr = homeComp?.team?.abbreviation?.toUpperCase() ?? "";
      if (homeAbbr === winAbbr) homeTeamWinStreak++;
      else homeTeamWinStreak = 0;
    }

    return {
      team1: team1Abbr.toUpperCase(),
      team2: team2Abbr.toUpperCase(),
      team1Wins: t1Wins,
      team2Wins: t2Wins,
      gamesPlayed: t1Wins + t2Wins,
      lastWinner,
      homeTeamWinStreak,
    };
  } catch {
    return null;
  }
}

function parseEspnEvent(e: any): NBAGame | null {
  try {
    const comps = e.competitions?.[0];
    if (!comps) return null;
    const home = comps.competitors?.find((c: any) => c.homeAway === "home");
    const away = comps.competitors?.find((c: any) => c.homeAway === "away");
    if (!home || !away) return null;

    const statusName: string = e.status?.type?.name ?? "STATUS_SCHEDULED";
    return {
      id: Number(e.id),
      date: e.date,
      homeTeam: teamFromEspnComp(home),
      awayTeam: teamFromEspnComp(away),
      homeScore: home.score ? Number(home.score) : undefined,
      awayScore: away.score ? Number(away.score) : undefined,
      status: espnStatus(statusName),
      period: comps.status?.period,
      time: comps.status?.displayClock,
    };
  } catch {
    return null;
  }
}

function teamFromEspnComp(comp: any): NBATeam {
  const records: any[] = comp.records ?? [];
  const overall = records.find((r: any) => r.name === "overall" || r.type === "total");
  const [w = 0, l = 0] = (overall?.summary ?? "0-0").split("-").map(Number);
  return {
    id: Number(comp.team?.id ?? 0),
    name: comp.team?.name ?? "Unknown",
    fullName: comp.team?.displayName ?? "Unknown",
    abbreviation: comp.team?.abbreviation ?? "UNK",
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

function normalizeStatus(s: string): InjuredPlayer["status"] {
  const lower = (s ?? "").toLowerCase();
  if (lower.includes("out")) return "Out";
  if (lower.includes("doubtful")) return "Doubtful";
  if (lower.includes("questionable")) return "Questionable";
  return "Day-To-Day";
}

function positionImpact(pos: string, status: InjuredPlayer["status"]): number {
  const baseByPos: Record<string, number> = {
    PG: 0.12, SG: 0.09, SF: 0.09, PF: 0.08, C: 0.08,
    G: 0.10, F: 0.09, "G/F": 0.09, "F/C": 0.08,
  };
  const base = baseByPos[pos] ?? 0.07;
  const statusMult: Record<InjuredPlayer["status"], number> = {
    Out: 1.0, Doubtful: 0.75, Questionable: 0.4, "Day-To-Day": 0.2,
  };
  return base * (statusMult[status] ?? 0.3);
}

function abbrFromDisplayName(name: string): string {
  const map: Record<string, string> = {
    "Atlanta Hawks": "ATL", "Boston Celtics": "BOS", "Brooklyn Nets": "BKN",
    "Charlotte Hornets": "CHA", "Chicago Bulls": "CHI", "Cleveland Cavaliers": "CLE",
    "Dallas Mavericks": "DAL", "Denver Nuggets": "DEN", "Detroit Pistons": "DET",
    "Golden State Warriors": "GSW", "Houston Rockets": "HOU", "Indiana Pacers": "IND",
    "LA Clippers": "LAC", "Los Angeles Lakers": "LAL", "Memphis Grizzlies": "MEM",
    "Miami Heat": "MIA", "Milwaukee Bucks": "MIL", "Minnesota Timberwolves": "MIN",
    "New Orleans Pelicans": "NOP", "New York Knicks": "NYK", "Oklahoma City Thunder": "OKC",
    "Orlando Magic": "ORL", "Philadelphia 76ers": "PHI", "Phoenix Suns": "PHX",
    "Portland Trail Blazers": "POR", "Sacramento Kings": "SAC", "San Antonio Spurs": "SAS",
    "Toronto Raptors": "TOR", "Utah Jazz": "UTA", "Washington Wizards": "WAS",
  };
  return map[name] ?? name.split(" ").pop()?.slice(0, 3).toUpperCase() ?? "";
}
