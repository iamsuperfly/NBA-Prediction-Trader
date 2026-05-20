import { getTeamForm, getPlayoffStandings, getInjuryReports, getSeriesState } from "../data/nba-client.js";
import type { NBAGame, NBAStandings, TeamForm, InjuryReport, SeriesState } from "../types.js";

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

  const [homeForm, awayForm, injuries] = await Promise.all([
    getTeamForm(game.homeTeam.abbreviation),
    getTeamForm(game.awayTeam.abbreviation),
    getInjuryReports(),
  ]);

  const homeInjury = injuries.get(game.homeTeam.abbreviation.toUpperCase()) ?? null;
  const awayInjury = injuries.get(game.awayTeam.abbreviation.toUpperCase()) ?? null;

  const logOdds = buildLogOdds({
    homeWinPct: game.homeTeam.winPct,
    awayWinPct: game.awayTeam.winPct,
    homeForm,
    awayForm,
    homeInjury,
    awayInjury,
    isHomeGame: true,
    factors,
    homeAbbr: game.homeTeam.abbreviation,
    awayAbbr: game.awayTeam.abbreviation,
  });

  const rawProb = sigmoid(logOdds);
  const homeWinProb = calibrate(rawProb);

  const recordDiff = Math.abs(game.homeTeam.winPct - game.awayTeam.winPct);
  const formDiff = Math.abs(homeForm.last10Wins - awayForm.last10Wins) / 10;
  const injuryImpact = Math.abs(
    (homeInjury?.impactScore ?? 0) - (awayInjury?.impactScore ?? 0)
  );
  const confidence = clamp(0.45 + recordDiff * 0.3 + formDiff * 0.2 + injuryImpact * 0.1, 0.45, 0.92);

  return {
    homeWinProbability: clamp(homeWinProb, 0.05, 0.95),
    awayWinProbability: clamp(1 - homeWinProb, 0.05, 0.95),
    confidence,
    factors,
  };
}

export async function predictSeries(
  team1Abbr: string,
  team2Abbr: string,
  standings: NBAStandings[]
): Promise<SeriesPrediction> {
  const factors: string[] = [];

  const s1 = findStanding(team1Abbr, standings);
  const s2 = findStanding(team2Abbr, standings);

  if (!s1 || !s2) {
    factors.push(`Could not find both teams in standings: ${team1Abbr} vs ${team2Abbr}`);
    return { favoredTeam: team1Abbr, winProbability: 0.5, confidence: 0.3, factors };
  }

  const [form1, form2, injuries, seriesState] = await Promise.all([
    getTeamForm(s1.team.abbreviation),
    getTeamForm(s2.team.abbreviation),
    getInjuryReports(),
    getSeriesState(s1.team.abbreviation, s2.team.abbreviation),
  ]);

  const inj1 = injuries.get(s1.team.abbreviation.toUpperCase()) ?? null;
  const inj2 = injuries.get(s2.team.abbreviation.toUpperCase()) ?? null;

  factors.push(
    `Seed: ${s1.team.abbreviation} #${s1.seed} (${s1.team.wins}-${s1.team.losses}) vs ${s2.team.abbreviation} #${s2.seed} (${s2.team.wins}-${s2.team.losses})`
  );
  factors.push(
    `Form L10: ${s1.team.abbreviation} ${form1.last10Wins}/10, ${s2.team.abbreviation} ${form2.last10Wins}/10`
  );
  factors.push(
    `Avg point diff L5: ${s1.team.abbreviation} ${form1.last5PointDiff.toFixed(1)}, ${s2.team.abbreviation} ${form2.last5PointDiff.toFixed(1)}`
  );

  const logOdds = buildLogOdds({
    homeWinPct: s1.team.winPct,
    awayWinPct: s2.team.winPct,
    homeForm: form1,
    awayForm: form2,
    homeInjury: inj1,
    awayInjury: inj2,
    isHomeGame: s1.seed < s2.seed,
    factors,
    homeAbbr: s1.team.abbreviation,
    awayAbbr: s2.team.abbreviation,
  });

  const seriesMomentumAdj = computeSeriesMomentum(
    s1.team.abbreviation,
    seriesState,
    factors
  );

  const adjustedLogOdds = logOdds + seriesMomentumAdj;
  const raw = sigmoid(adjustedLogOdds);
  const t1WinProb = calibrate(raw);

  const favored = t1WinProb >= 0.5 ? s1.team.abbreviation : s2.team.abbreviation;
  const favoredProb = Math.max(t1WinProb, 1 - t1WinProb);

  const seedDiff = Math.abs(s1.seed - s2.seed) / 8;
  const recordDiff = Math.abs(s1.team.winPct - s2.team.winPct);
  const formDiff = Math.abs(form1.last10Wins - form2.last10Wins) / 10;
  const confidence = clamp(0.4 + seedDiff * 0.2 + recordDiff * 0.25 + formDiff * 0.15, 0.4, 0.88);

  return {
    favoredTeam: favored,
    winProbability: clamp(favoredProb, 0.05, 0.95),
    confidence,
    factors,
  };
}

interface LogOddsInput {
  homeWinPct: number;
  awayWinPct: number;
  homeForm: TeamForm;
  awayForm: TeamForm;
  homeInjury: InjuryReport | null;
  awayInjury: InjuryReport | null;
  isHomeGame: boolean;
  factors: string[];
  homeAbbr: string;
  awayAbbr: string;
}

function buildLogOdds(input: LogOddsInput): number {
  const {
    homeWinPct, awayWinPct,
    homeForm, awayForm,
    homeInjury, awayInjury,
    isHomeGame, factors,
    homeAbbr, awayAbbr,
  } = input;

  const safeLog = (p: number) => Math.log(clamp(p, 0.01, 0.99) / clamp(1 - p, 0.01, 0.99));

  const recordLogOdds = safeLog(homeWinPct) - safeLog(awayWinPct);

  const homeLast10Pct = homeForm.last10Wins / 10;
  const awayLast10Pct = awayForm.last10Wins / 10;
  const formLogOdds = safeLog(homeLast10Pct) - safeLog(awayLast10Pct);

  const homeLast5Pct = homeForm.last5Wins / 5;
  const awayLast5Pct = awayForm.last5Wins / 5;
  const recentFormLogOdds = safeLog(homeLast5Pct) - safeLog(awayLast5Pct);

  const homeCourtAdj = isHomeGame ? 0.18 : -0.18;

  const homePointDiffAdj = homeForm.last5PointDiff / 20;
  const awayPointDiffAdj = awayForm.last5PointDiff / 20;
  const pointDiffAdj = homePointDiffAdj - awayPointDiffAdj;

  const homeSplitAdj = safeLog(homeForm.homeWinPct) - safeLog(awayForm.awayWinPct);

  const homeInjAdj = homeInjury ? -homeInjury.impactScore * 1.5 : 0;
  const awayInjAdj = awayInjury ? awayInjury.impactScore * 1.5 : 0;
  const injuryAdj = homeInjAdj + awayInjAdj;

  if (homeInjury?.players.length) {
    const outs = homeInjury.players.filter((p) => p.status === "Out");
    if (outs.length) factors.push(`${homeAbbr} OUT: ${outs.map((p) => p.name).join(", ")}`);
  }
  if (awayInjury?.players.length) {
    const outs = awayInjury.players.filter((p) => p.status === "Out");
    if (outs.length) factors.push(`${awayAbbr} OUT: ${outs.map((p) => p.name).join(", ")}`);
  }

  factors.push(
    `${homeAbbr} home split: ${(homeForm.homeWinPct * 100).toFixed(0)}% | ${awayAbbr} road split: ${(awayForm.awayWinPct * 100).toFixed(0)}%`
  );
  factors.push(
    `Point diff L5: ${homeAbbr} ${homeForm.last5PointDiff >= 0 ? "+" : ""}${homeForm.last5PointDiff.toFixed(1)}, ${awayAbbr} ${awayForm.last5PointDiff >= 0 ? "+" : ""}${awayForm.last5PointDiff.toFixed(1)}`
  );

  return (
    0.30 * recordLogOdds +
    0.22 * formLogOdds +
    0.18 * recentFormLogOdds +
    0.15 * homeCourtAdj +
    0.08 * pointDiffAdj +
    0.04 * homeSplitAdj +
    0.03 * injuryAdj
  );
}

function computeSeriesMomentum(
  team1Abbr: string,
  series: SeriesState | null,
  factors: string[]
): number {
  if (!series || series.gamesPlayed === 0) return 0;

  const { team1Wins, team2Wins, lastWinner, homeTeamWinStreak, gamesPlayed } = series;

  const t1Abbr = team1Abbr.toUpperCase();
  factors.push(`Series: ${series.team1} ${team1Wins}-${team2Wins} ${series.team2} (${gamesPlayed} played)`);

  let adj = 0;

  if (gamesPlayed >= 2) {
    const seriesLead = (team1Wins - team2Wins) / Math.max(gamesPlayed, 1);
    adj += seriesLead * 0.25;
  }

  if (lastWinner) {
    const momentumBoost = lastWinner === t1Abbr ? 0.12 : -0.12;
    adj += momentumBoost;
    factors.push(`Last game won by: ${lastWinner} (momentum +${(momentumBoost * 100).toFixed(0)}%)`);
  }

  if (homeTeamWinStreak >= 2) {
    const homeCourtEffect = homeTeamWinStreak === t1Abbr ? 0.08 : -0.08;
    adj += homeCourtEffect;
    factors.push(`Home team win streak: ${homeTeamWinStreak} games`);
  }

  if (team1Wins === 3 || team2Wins === 3) {
    const mustWin = team1Wins === 3 ? -0.15 : 0.15;
    adj += mustWin;
    factors.push(`Must-win scenario for ${team1Wins === 3 ? series.team2 : series.team1}`);
  }

  return adj;
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

function calibrate(p: number): number {
  return 0.05 + p * 0.9;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function findStanding(abbr: string, standings: NBAStandings[]): NBAStandings | null {
  const upper = abbr.toUpperCase();
  return (
    standings.find(
      (s) =>
        s.team.abbreviation.toUpperCase() === upper ||
        s.team.name.toLowerCase().includes(abbr.toLowerCase()) ||
        s.team.fullName.toLowerCase().includes(abbr.toLowerCase())
    ) ?? null
  );
}
