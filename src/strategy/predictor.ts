import { getTeamRecentForm, getPlayoffStandings } from "../data/nba-client.js";
import type { NBAGame, NBAStandings } from "../types.js";

export interface GamePrediction {
  homeWinProbability: number;
  awayWinProbability: number;
  confidence: number;
  factors: string[];
}

export interface SeriesPrediction {
  favoredTeam: string;
  winProbability: number;
  confidence: number;
  factors: string[];
}

export async function predictGame(game: NBAGame): Promise<GamePrediction> {
  const factors: string[] = [];
  let homeAdvantage = 0.03;

  const homeWinPct = game.homeTeam.winPct;
  const awayWinPct = game.awayTeam.winPct;

  factors.push(
    `Season record: ${game.homeTeam.abbreviation} ${game.homeTeam.wins}-${game.homeTeam.losses} vs ${game.awayTeam.abbreviation} ${game.awayTeam.wins}-${game.awayTeam.losses}`
  );

  const [homeForm, awayForm] = await Promise.all([
    getTeamRecentForm(game.homeTeam.abbreviation),
    getTeamRecentForm(game.awayTeam.abbreviation),
  ]);

  const homeLast5Pct = homeForm.last5Wins / 5;
  const awayLast5Pct = awayForm.last5Wins / 5;
  factors.push(
    `Last 5 games: ${game.homeTeam.abbreviation} ${homeForm.last5Wins}/5, ${game.awayTeam.abbreviation} ${awayForm.last5Wins}/5`
  );

  const homeHomePct = homeForm.homeWinPct;
  factors.push(`Home win%: ${game.homeTeam.abbreviation} ${(homeHomePct * 100).toFixed(0)}%`);

  const logOddsWinPct = Math.log(homeWinPct / (1 - homeWinPct)) - Math.log(awayWinPct / (1 - awayWinPct));
  const logOddsForm = Math.log((homeLast5Pct + 0.01) / (1 - homeLast5Pct + 0.01))
    - Math.log((awayLast5Pct + 0.01) / (1 - awayLast5Pct + 0.01));
  const logOddsHome = Math.log((homeHomePct + 0.01) / (1 - homeHomePct + 0.01));

  const combinedLogOdds =
    0.4 * logOddsWinPct +
    0.35 * logOddsForm +
    0.15 * logOddsHome +
    homeAdvantage;

  const homeWinProb = 1 / (1 + Math.exp(-combinedLogOdds));

  const recordDiff = Math.abs(homeWinPct - awayWinPct);
  const confidence = Math.min(0.9, 0.5 + recordDiff * 0.5);

  return {
    homeWinProbability: Math.max(0.05, Math.min(0.95, homeWinProb)),
    awayWinProbability: Math.max(0.05, Math.min(0.95, 1 - homeWinProb)),
    confidence,
    factors,
  };
}

export async function predictSeries(
  team1: string,
  team2: string,
  standings: NBAStandings[]
): Promise<SeriesPrediction> {
  const factors: string[] = [];

  const s1 = standings.find(
    (s) =>
      s.team.abbreviation.toUpperCase() === team1.toUpperCase() ||
      s.team.name.toLowerCase().includes(team1.toLowerCase())
  );
  const s2 = standings.find(
    (s) =>
      s.team.abbreviation.toUpperCase() === team2.toUpperCase() ||
      s.team.name.toLowerCase().includes(team2.toLowerCase())
  );

  if (!s1 || !s2) {
    factors.push("Could not find both teams in standings — using 50/50");
    return { favoredTeam: team1, winProbability: 0.5, confidence: 0.3, factors };
  }

  factors.push(
    `${s1.team.abbreviation} seed #${s1.seed} (${s1.team.wins}-${s1.team.losses})`,
    `${s2.team.abbreviation} seed #${s2.seed} (${s2.team.wins}-${s2.team.losses})`
  );

  const [form1, form2] = await Promise.all([
    getTeamRecentForm(s1.team.abbreviation),
    getTeamRecentForm(s2.team.abbreviation),
  ]);

  const winPct1 = s1.team.winPct;
  const winPct2 = s2.team.winPct;
  const form1Score = form1.last10Wins / 10;
  const form2Score = form2.last10Wins / 10;

  factors.push(
    `Last 10: ${s1.team.abbreviation} ${form1.last10Wins}/10, ${s2.team.abbreviation} ${form2.last10Wins}/10`
  );

  const team1Score = 0.55 * winPct1 + 0.45 * form1Score;
  const team2Score = 0.55 * winPct2 + 0.45 * form2Score;

  const total = team1Score + team2Score;
  const team1WinProb = total > 0 ? team1Score / total : 0.5;

  const favored = team1WinProb >= 0.5 ? s1.team.abbreviation : s2.team.abbreviation;
  const favoredProb = Math.max(team1WinProb, 1 - team1WinProb);
  const confidence = Math.min(0.85, 0.4 + Math.abs(winPct1 - winPct2) * 0.8);

  return {
    favoredTeam: favored,
    winProbability: Math.max(0.05, Math.min(0.95, favoredProb)),
    confidence,
    factors,
  };
}
