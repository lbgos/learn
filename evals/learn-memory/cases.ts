// Synthetic learner notes and the questions that should reach them. Made up: no real learner's data.
import * as DateTime from "effect/DateTime";

/** The eval's "now"; note dates and `until` dates are relative to it. */
export const NOW = "2026-11-10T09:00:00.000Z";

export interface GoldNote {
  readonly text: string;
  /** YYYY-MM-DD the note was saved. */
  readonly at: string;
  readonly until?: string;
  readonly pinned?: boolean;
}

/** Notes a tutor would keep about one learner, in English, Russian and Ukrainian. */
export const goldNotes = {
  examDate: { text: "Mechanics exam on 18 December, written part only.", at: "2026-10-02" },
  examDateOld: { text: "Mechanics exam on 4 December.", at: "2026-09-12" },
  goal: {
    text: "Goal: pass the first-year university physics course with at least a B.",
    at: "2026-09-10",
    pinned: true,
  },
  language: {
    text: "Wants explanations in Russian, formulas in standard notation.",
    at: "2026-09-10",
    pinned: true,
  },
  derivations: {
    text: "Prefers a derivation before the formula; dislikes memorising results.",
    at: "2026-09-14",
  },
  sims: { text: "Learns better from a simulation than from a static diagram.", at: "2026-09-20" },
  shortAnswers: {
    text: "Short feedback after a correct answer; detailed only after a miss.",
    at: "2026-09-21",
  },
  signs: { text: "Drops minus signs when projecting forces onto tilted axes.", at: "2026-10-05" },
  units: { text: "Forgets to convert km/h to m/s before substituting.", at: "2026-10-07" },
  vectorsWeak: {
    text: "Shaky on vector cross products; right-hand rule confuses them.",
    at: "2026-10-09",
  },
  calculus: {
    text: "Comfortable with derivatives; integrals by substitution still slow.",
    at: "2026-09-16",
  },
  background: {
    text: "Studied chemistry at school, took no physics in the last two years.",
    at: "2026-09-10",
  },
  schedule: {
    text: "Studies on weekday evenings after 20:00, about 40 minutes a session.",
    at: "2026-09-11",
  },
  tired: { text: "On Fridays prefers practice problems over new theory.", at: "2026-09-25" },
  calculator: {
    text: "Uses a Casio fx-991 calculator in exams; no graphing calculator allowed.",
    at: "2026-09-30",
  },
  textbook: {
    text: "Course textbook: Halliday, Fundamentals of Physics, 11th edition.",
    at: "2026-09-12",
  },
  lecturer: { text: "Lecturer marks down answers without units.", at: "2026-10-01" },
  labReport: {
    text: "Lab report on the pendulum due 20 November.",
    at: "2026-10-20",
    until: "2026-11-20",
  },
  energyGood: {
    text: "Solid on energy conservation; solves those problems quickly.",
    at: "2026-10-12",
  },
  rotation: {
    text: "Rotation is new: torque and moment of inertia not yet seen.",
    at: "2026-10-15",
  },
  graphs: {
    text: "Reads position-time graphs well but mixes up slope and area on velocity-time graphs.",
    at: "2026-10-03",
  },
  anxiety: {
    text: "Gets anxious under time pressure; timed drills only when asked.",
    at: "2026-09-28",
  },
  examples: { text: "Likes examples from cycling and skiing.", at: "2026-09-18" },
  ruOhms: {
    text: "Путает последовательное и параллельное соединение резисторов.",
    at: "2026-10-18",
  },
  ruNotation: {
    text: "Привык обозначать скорость через v, а ускорение через a, без стрелок.",
    at: "2026-09-19",
  },
  ruMath: {
    text: "Плохо помнит тригонометрические тождества, особенно для двойного угла.",
    at: "2026-10-11",
  },
  ruExam2: { text: "Зачёт по математическому анализу 9 декабря.", at: "2026-10-22" },
  ukFriction: { text: "Плутає коефіцієнти тертя спокою і ковзання.", at: "2026-10-14" },
  ukPace: {
    text: "Хоче повільніший темп на нових темах і швидший на повторенні.",
    at: "2026-09-24",
  },
  ukHomework: { text: "Домашні завдання здає в понеділок до 9:00.", at: "2026-09-26" },
  ukVisual: { text: "Краще запам'ятовує, коли сам малює схему сил.", at: "2026-10-04" },
  phoneOnly: {
    text: "Often studies on a phone, so wide tables are hard to read.",
    at: "2026-10-08",
  },
  breakLong: {
    text: "Will be away from 22 to 29 November; plan review before that.",
    at: "2026-11-01",
    until: "2026-11-29",
  },
  partner: {
    text: "Studies with a classmate on Sundays and wants problems to share.",
    at: "2026-10-25",
  },
} as const satisfies Record<string, GoldNote>;

export type GoldKey = keyof typeof goldNotes;

export type QuestionType = "single" | "paraphrase" | "cross" | "update" | "abstain";

export interface Question {
  readonly id: string;
  readonly type: QuestionType;
  /** The learner's message that starts the turn. */
  readonly message: string;
  /** The tutor's last reply, for a short follow-up. */
  readonly lastReply?: string;
  /** Notes the turn should reach; empty for `abstain`. */
  readonly gold: ReadonlyArray<GoldKey>;
  /** For `update`: the older note the newer one replaces. */
  readonly older?: GoldKey;
}

export const questions: ReadonlyArray<Question> = [
  // The note's words.
  {
    id: "s-exam",
    type: "single",
    message: "How many weeks until my mechanics exam?",
    gold: ["examDate"],
  },
  {
    id: "s-signs",
    type: "single",
    message: "I keep getting the sign wrong when I project forces on tilted axes.",
    gold: ["signs"],
  },
  {
    id: "s-units",
    type: "single",
    message: "The car goes 72 km/h, do I plug that in directly?",
    gold: ["units"],
  },
  {
    id: "s-cross",
    type: "single",
    message: "Can we practise cross products with the right-hand rule?",
    gold: ["vectorsWeak"],
  },
  {
    id: "s-integral",
    type: "single",
    message: "Let's do some integrals by substitution today.",
    gold: ["calculus"],
  },
  {
    id: "s-calc",
    type: "single",
    message: "Which calculator can I use for this kind of problem in the exam?",
    gold: ["calculator"],
  },
  {
    id: "s-textbook",
    type: "single",
    message: "Which chapter of the textbook covers this?",
    gold: ["textbook"],
  },
  {
    id: "s-lab",
    type: "single",
    message: "When is the pendulum lab report due?",
    gold: ["labReport"],
  },
  {
    id: "s-torque",
    type: "single",
    message: "We start torque and moment of inertia tomorrow in lectures.",
    gold: ["rotation"],
  },
  {
    id: "s-vt",
    type: "single",
    message: "Is the distance the slope or the area on a velocity-time graph?",
    gold: ["graphs"],
  },
  { id: "s-friday", type: "single", message: "It's Friday, what should we do?", gold: ["tired"] },
  {
    id: "s-ru-ohm",
    type: "single",
    message: "Как считать сопротивление при параллельном соединении резисторов?",
    gold: ["ruOhms"],
  },
  {
    id: "s-ru-trig",
    type: "single",
    message: "Напомни тригонометрические тождества двойного угла.",
    gold: ["ruMath"],
  },
  {
    id: "s-uk-friction",
    type: "single",
    message: "Який коефіцієнт тертя брати, ковзання чи спокою?",
    gold: ["ukFriction"],
  },
  {
    id: "s-uk-homework",
    type: "single",
    message: "Коли мені здавати домашні завдання?",
    gold: ["ukHomework"],
  },
  // The note's language, other words.
  {
    id: "p-derive",
    type: "paraphrase",
    message: "Don't just give me the equation, show me where it comes from.",
    gold: ["derivations"],
  },
  {
    id: "p-sim",
    type: "paraphrase",
    message: "Could I play with something interactive instead of a picture?",
    gold: ["sims"],
  },
  {
    id: "p-short",
    type: "paraphrase",
    message: "Got it right! How much do you need to say about it?",
    gold: ["shortAnswers"],
  },
  {
    id: "p-timed",
    type: "paraphrase",
    message: "Should we race the clock on these problems?",
    gold: ["anxiety"],
  },
  {
    id: "p-examples",
    type: "paraphrase",
    message: "Give me a real-life situation for kinetic energy, something I'd enjoy.",
    gold: ["examples", "energyGood"],
  },
  {
    id: "p-phone",
    type: "paraphrase",
    message: "I'm on my mobile right now, keep the layout simple.",
    gold: ["phoneOnly"],
  },
  {
    id: "p-sunday",
    type: "paraphrase",
    message: "My study buddy and I meet this weekend, anything we can work on together?",
    gold: ["partner"],
  },
  {
    id: "p-schedule",
    type: "paraphrase",
    message: "How long should tonight's lesson be?",
    gold: ["schedule"],
  },
  {
    id: "p-background",
    type: "paraphrase",
    message: "Assume I know nothing from high school physics, is that right?",
    gold: ["background"],
  },
  {
    id: "p-goal",
    type: "paraphrase",
    message: "What grade am I aiming for again?",
    gold: ["goal"],
  },
  {
    id: "p-trip",
    type: "paraphrase",
    message: "I'm travelling at the end of the month, what should we cover first?",
    gold: ["breakLong"],
  },
  {
    id: "p-uk-draw",
    type: "paraphrase",
    message: "Можна я сам намалюю, які сили діють на брусок?",
    gold: ["ukVisual"],
  },
  {
    id: "p-ru-arrows",
    type: "paraphrase",
    message: "Надо ли рисовать стрелочки над буквами в формулах?",
    gold: ["ruNotation"],
  },
  // Asked in another language than the note.
  {
    id: "c-ru-exam",
    type: "cross",
    message: "Когда у меня экзамен по механике?",
    gold: ["examDate"],
  },
  {
    id: "c-uk-signs",
    type: "cross",
    message: "Знову помилився зі знаком у проекціях сил на похилу площину.",
    gold: ["signs"],
  },
  {
    id: "c-ru-units",
    type: "cross",
    message: "Скорость 90 км/ч, сразу подставлять в формулу?",
    gold: ["units"],
  },
  {
    id: "c-uk-sim",
    type: "cross",
    message: "Покажи це краще на симуляції, ніж на малюнку.",
    gold: ["sims"],
  },
  {
    id: "c-ru-calc",
    type: "cross",
    message: "Какой калькулятор можно на экзамене?",
    gold: ["calculator"],
  },
  {
    id: "c-en-ohms",
    type: "cross",
    message: "Series or parallel resistors, which formula adds the resistances?",
    gold: ["ruOhms"],
  },
  {
    id: "c-en-friction",
    type: "cross",
    message: "Static or kinetic friction coefficient here?",
    gold: ["ukFriction"],
  },
  {
    id: "c-en-trig",
    type: "cross",
    message: "What's the double-angle identity for sine again?",
    gold: ["ruMath"],
  },
  {
    id: "c-en-pace",
    type: "cross",
    message: "Can we go slower since this topic is new to me?",
    gold: ["ukPace"],
  },
  { id: "c-en-calc-exam", type: "cross", message: "When is my calculus test?", gold: ["ruExam2"] },
  {
    id: "c-uk-rotation",
    type: "cross",
    message: "Що таке момент інерції? Ми цього ще не проходили.",
    gold: ["rotation"],
  },
  {
    id: "c-ru-derive",
    type: "cross",
    message: "Не надо просто формулу, выведи её.",
    gold: ["derivations"],
  },
  // A newer note replaces an older one: the newer must reach the turn.
  {
    id: "u-exam",
    type: "update",
    message: "Is the mechanics exam still on 4 December?",
    gold: ["examDate"],
    older: "examDateOld",
  },
  {
    id: "u-exam-ru",
    type: "update",
    message: "Напомни дату экзамена по механике.",
    gold: ["examDate"],
    older: "examDateOld",
  },
  // No note holds the answer: recall should stay quiet.
  { id: "a-pet", type: "abstain", message: "What's the name of my dog?", gold: [] },
  {
    id: "a-optics",
    type: "abstain",
    message: "Explain total internal reflection in optical fibres.",
    gold: [],
  },
  { id: "a-ru-chem", type: "abstain", message: "Как уравнять реакцию горения метана?", gold: [] },
  { id: "a-uk-music", type: "abstain", message: "Яка твоя улюблена музика?", gold: [] },
  { id: "a-coffee", type: "abstain", message: "Thanks, see you tomorrow!", gold: [] },
  {
    id: "a-follow",
    type: "abstain",
    message: "the second one",
    lastReply: "Two ways to see this: 1) with energy 2) with forces.",
    gold: [],
  },
];

const TOPICS = [
  "kinematics",
  "projectile motion",
  "Newton's third law",
  "momentum",
  "impulse",
  "work",
  "power",
  "springs",
  "circular motion",
  "gravitation",
  "oscillations",
  "waves",
  "sound",
  "pressure",
  "buoyancy",
  "heat capacity",
  "ideal gases",
  "electric field",
  "capacitors",
  "magnetic field",
  "induction",
  "lenses",
  "limits",
  "series",
  "matrices",
  "probability",
];
const RU_TOPICS = [
  "кинематика",
  "импульс",
  "колебания",
  "волны",
  "давление",
  "теплоёмкость",
  "индукция",
  "линзы",
  "пределы",
  "матрицы",
];
const UK_TOPICS = [
  "кінематика",
  "імпульс",
  "коливання",
  "хвилі",
  "тиск",
  "індукція",
  "лінзи",
  "границі",
  "матриці",
];
const TEMPLATES = [
  (t: string) => `Watched a lecture video on ${t}.`,
  (t: string) => `Asked to revisit ${t} after the midterm.`,
  (t: string) => `Finished the problem set on ${t} with two hints.`,
  (t: string) => `Found the ${t} chapter summary useful.`,
  (t: string) => `Wants a cheat sheet for ${t} at the end of the unit.`,
  (t: string) => `Mentioned a friend who tutors ${t}.`,
  (t: string) => `Skipped the optional reading on ${t}.`,
  (t: string) => `Liked the animation used for ${t}.`,
  (t: string) => `Посмотрел лекцию про ${t}.`,
  (t: string) => `Попросил вернуться к теме ${t} позже.`,
  (t: string) => `Переглянув конспект з теми ${t}.`,
  (t: string) => `Хоче шпаргалку з теми ${t}.`,
] as const;

/** Seeded so every run sees the same notes. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/** Notes that look like the learner's but hold no answer, up to `count` notes in all. */
export function distractors(count: number): GoldNote[] {
  const next = random(20261110);
  const out: GoldNote[] = [];
  const seen = new Set<string>();
  const gold = Object.keys(goldNotes).length;
  while (out.length < count - gold) {
    const index = Math.floor(next() * TEMPLATES.length);
    const template = TEMPLATES[index]!;
    // The last four templates are Russian, then Ukrainian, and take topics in their language.
    const pool = index >= 10 ? UK_TOPICS : index >= 8 ? RU_TOPICS : TOPICS;
    const topic = pool[Math.floor(next() * pool.length)]!;
    const day = 1 + Math.floor(next() * 60);
    const text = `${template(topic)}${next() < 0.5 ? "" : ` Week ${1 + Math.floor(next() * 12)}.`}`;
    if (seen.has(text)) continue;
    seen.add(text);
    const at = DateTime.formatIso(
      DateTime.add(DateTime.makeUnsafe("2026-09-01"), { days: day }),
    ).slice(0, 10);
    out.push({ text, at });
  }
  return out;
}
