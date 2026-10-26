/**
 * The coach's safety checks that do not need a model: cleaning what people type, spotting attacks on the model and
 * people in crisis before anything is sent to it, and filtering what comes back. They sit around Llama Guard (the safety
 * model) and the system prompt's rules, so no single layer has to be perfect. Pure, so every rule is unit tested.
 */

/** Characters that change how text looks or reads while staying invisible: zero-width, direction controls, soft hyphen. */
const INVISIBLE = /[­​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
/** Chat-template markers of common models. Typed by a person they can only be an attempt to forge a turn. */
const TEMPLATE_TOKENS =
  /<\|[^|>\n]{1,40}\|>|\[\/?INST\]|<<\/?SYS>>|<\/?s>|<\/?(?:system|assistant|user|developer)>/gi;

/** What a person typed, made safe to put in a prompt: normalised, invisible and template characters removed, trimmed. */
export function cleanInput(text: string, max: number): string {
  return text
    .normalize('NFKC') // full-width and look-alike letters become plain ones, so the checks below see them
    .replace(INVISIBLE, '')
    .replace(CONTROL, ' ')
    .replace(TEMPLATE_TOKENS, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}

/**
 * Text typed into the app that goes into the coach's context (meal and workout names): marked word by word, so the model
 * can always tell it is data even if it contains instructions ("datamarking", from Microsoft's spotlighting paper), and
 * wrapped in brackets the person cannot type.
 */
export function datamark(text: string, max = 40): string {
  const words = cleanInput(text, max).replace(/[⟦⟧^]/g, '').split(/\s+/).filter(Boolean);
  return `⟦${words.join('^')}⟧`;
}

const ATTACKS: [string, RegExp][] = [
  [
    'ignore-instructions',
    /\b(ignore|disregard|forget|override|bypass|skip)\b.{0,40}\b(previous|above|prior|earlier|preceding|all|your|any|the|these|those)\b.{0,30}\b(instructions?|prompts?|directions?|directives?|system messages?)\b/,
  ],
  [
    'reveal-prompt',
    /\b(system|hidden|initial|original|developer|secret|internal)\s+(prompt|instructions?|message)\b|\b(print|show|reveal|repeat|output|display|dump|leak|recite|tell me)\b.{0,30}\b(your|the)\s+(prompt|instructions|system message|configuration)\b|\bwords? above\b/,
  ],
  [
    'role-change',
    /\b(you are now|from now on,? you (are|will)|pretend (to be|you are|you're)|role-?play as|you('| a)re no longer|new persona|switch (to|into) .{0,20}mode)\b/,
  ],
  [
    'jailbreak',
    /\b(jailbreak|dan mode|do anything now|developer mode|god mode|unfiltered mode|no restrictions|without (any )?(rules|restrictions|limits|filters|guidelines))\b/,
  ],
  ['forged-turn', /^\s*(system|assistant|developer|pango)\s*:/m],
  ['encoded', /[A-Za-z0-9+/]{120,}={0,2}/],
];

/** Signs of an attempt to turn the coach against its rules. An empty list means none were seen. */
export function attackSignals(text: string): string[] {
  const t = text.toLowerCase();
  return ATTACKS.filter(([name, re]) => (name === 'encoded' ? re.test(text) : re.test(t))).map(
    ([name]) => name,
  );
}

const SELF_HARM =
  /\b(kill(ing)? myself|suicid\w*|end (it all|my life)|want(ed)? to die|don'?t want to (live|be alive|be here)|self[- ]?harm\w*|cut(ting)? myself|hurt(ing)? myself|no reason to live|better off dead|selfmoord|wil (nie meer )?(leef|lewe)|maak myself dood)\b/i;
const EATING_DISORDER =
  /\b(make myself (sick|throw up|vomit|puke)|throw(ing)? up after (i eat|eating|meals?|food)|purg(e|es|ed|ing)\b|laxatives? (to|for) (lose|losing|weight|slim\w*)|(use|take|taking|using) laxatives?|starv(e|ing) myself|stop eating (completely|for days|altogether)|eat(ing)? nothing (for|all)|not eat(ing)? for \d+ days|anorexi\w*|bulimi\w*|pro[- ]?ana|thinspo\w*|hate my body)\b/i;

export type Crisis = 'self-harm' | 'eating';

/** Someone who may be in danger gets a fixed, kind answer with helplines, never a model's improvisation. */
export function crisisIn(text: string): Crisis | null {
  if (SELF_HARM.test(text)) return 'self-harm';
  if (EATING_DISORDER.test(text)) return 'eating';
  return null;
}

/** South African helplines, checked on SADAG's site (Oct 2026). */
export const CRISIS_REPLY: Record<Crisis, string> = {
  'self-harm':
    "I'm really sorry you're feeling this way, and I'm glad you said something. You don't have to carry this alone. " +
    "Please talk to someone now: SADAG's Suicide Crisis Helpline is 0800 567 567 (free, 24 hours) and Lifeline is 0861 322 322. " +
    "If you are in danger right now, call 112 from a cellphone or 10111. I'm a food and fitness buddy, not a counsellor, but I'm here whenever you want to talk meals or moving.",
  eating:
    'It sounds like food has been really hard lately, and that matters. You deserve support from someone trained to help. ' +
    'Please speak to a doctor or a registered dietitian, or call the Cipla Mental Health Helpline on 0800 456 789 (SADAG, free, 24 hours). ' +
    "I won't give tips on eating less, but I'm happy to help with gentle, regular meals whenever you're ready.",
};

export const SCOPE_REPLY =
  "I can't do that one, but I'd love to help with food, training, sleep or staying motivated. What are you working on today?";
export const FALLBACK_REPLY =
  "Sorry, I can't help with that. I'm best with meals, training and motivation. For anything medical, please check with a doctor or registered dietitian.";

/** Llama Guard's categories that end a request whatever it says: crimes, sexual content, weapons, hate. */
export const BLOCKED_CATEGORIES = new Set(['S1', 'S2', 'S3', 'S4', 'S9', 'S10', 'S12']);
/** S11 is suicide and self-harm: answered with helplines. */
export const SELF_HARM_CATEGORY = 'S11';

const DANGEROUS_SUBSTANCES =
  /\b(dnp|dinitrophenol|clenbuterol|ephedrine|sibutramine|phentermine|ipecac|syrup of ipecac)\b/i;
const MEDICINES =
  'insulin|metformin|gliclazide|glimepiride|ozempic|semaglutide|wegovy|mounjaro|tirzepatide|saxenda|liraglutide|orlistat|levothyroxine|eltroxin|prednisone|steroids?|diuretics?|laxatives?|dapagliflozin|empagliflozin|forxiga|jardiance';
const DOSE = new RegExp(
  `\\b\\d+(?:[.,]\\d+)?\\s*(?:mg|mcg|µg|ug|units?|iu|ml|tablets?|pills?)\\b[^.\\n]{0,40}\\b(?:${MEDICINES})\\b|\\b(?:${MEDICINES})\\b[^.\\n]{0,40}\\b\\d+(?:[.,]\\d+)?\\s*(?:mg|mcg|µg|ug|units?|iu|ml|tablets?|pills?)\\b`,
  'i',
);
const DAILY_KCAL =
  /(\d[\d ,.]{1,6})\s*(?:k?cal(?:ories)?|kcal)\s*(?:a|per|each|every)\s*day|daily\s*(?:intake|total|target|budget)?\s*(?:of|to|at)?\s*(\d[\d ,.]{1,6})\s*(?:k?cal(?:ories)?|kcal)/gi;
/** Words before a number that mean it is not an intake being recommended ("a deficit of 500 kcal a day", "never below"). */
const NOT_INTAKE =
  /\b(deficit|burn\w*|cut(ting)?|fewer|less|reduc\w*|lower\w*|drop\w*|minus|under|below|surplus|extra|more|never|don'?t|do not|avoid|not|instead of)\b/i;
/** Words after it that mean it is a warning ("600 calories a day is too low"). */
const WARNING_AFTER =
  /^[^.\n]{0,60}\b(too low|too little|not (safe|enough|recommended|healthy|sustainable)|unsafe|dangerous|risky|harmful|isn'?t|is not)\b/i;
/** An answer that describes the coach's own rules or instructions, in any words. */
const RULES_TALK =
  /\b(guidelines|rules|instructions|principles)\s+(that\s+)?i\s+(follow|was given|have been given|work by|operate (by|under))\b|\bhere are (my|the) (guidelines|rules|instructions)\b|\bmy (system )?(prompt|instructions|programming)\b|\bi('m| am) (programmed|instructed|told) (to|not to)\b/i;

export type OutputCheck = { text: string; flags: string[]; blocked: boolean };

/**
 * The model's answer, checked before anyone sees it: a leaked system prompt, medicine doses, dangerous substances or a
 * daily calorie target under the floor block the answer; links, images and HTML are removed (they are how injected
 * instructions smuggle data out, and the app shows plain text only).
 */
export function checkOutput(
  text: string,
  opts: { canary: string; floorKcal: number; promptMarkers: string[]; minor?: boolean },
): OutputCheck {
  const flags: string[] = [];
  if (text.includes(opts.canary) || opts.promptMarkers.some((m) => text.includes(m)) || RULES_TALK.test(text))
    flags.push('prompt-leak');
  // Under-18s get no calorie targets (a day's worth is 1,000 kcal or more).
  if (opts.minor && /\b(1[ ,.]?\d{3}|[2-4][ ,.]?\d{3})\s*(k?cal|calories|kilojoules|kj)\b/i.test(text))
    flags.push('minor-calorie-target');
  if (DOSE.test(text)) flags.push('medicine-dose');
  if (DANGEROUS_SUBSTANCES.test(text)) flags.push('dangerous-substance');
  for (const m of text.matchAll(DAILY_KCAL)) {
    const n = Number((m[1] ?? m[2] ?? '').replace(/[ ,.]/g, ''));
    const before = text.slice(Math.max(0, (m.index ?? 0) - 30), m.index ?? 0);
    const after = text.slice((m.index ?? 0) + m[0].length);
    if (n >= 400 && n < opts.floorKcal && !NOT_INTAKE.test(before) && !WARNING_AFTER.test(after))
      flags.push('below-calorie-floor');
  }
  let clean = text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // markdown images
    .replace(/\[([^\]]{1,200})\]\([^)]*\)/g, '$1') // markdown links keep their words
    .replace(/<[^>\n]{1,200}>/g, '') // HTML tags
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, '') // bare addresses
    .replace(/^#{1,6}\s+/gm, '')
    .replace(INVISIBLE, '')
    .replace(TEMPLATE_TOKENS, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (clean !== text.trim()) flags.push('cleaned');
  if (clean.length > 1500) clean = clean.slice(0, 1500).replace(/\s+\S*$/, '') + '…';
  const blocked = flags.some((f) => f !== 'cleaned');
  return { text: blocked ? FALLBACK_REPLY : clean, flags, blocked };
}
