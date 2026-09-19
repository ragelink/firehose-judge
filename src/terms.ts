// Cheap term extraction for the trending cloud and the co-occurrence graph.
// Runs on every judged post, so it stays regex-only: no Jev call, no tokenizer.
// Terms come out best-signal-first — hashtags, proper-noun phrases, acronyms,
// bigrams, then bare words — because the cap is spent from the top and
// firehose.ts links only the first few terms of a post into the graph.

export const STOP = new Set(`a about above after again against all also am an and any are aren't as at be because been before being below
between both but by can can't could couldn't did didn't do does doesn't doing don't down during each few for from further get
got had hadn't has hasn't have haven't having he he'd he'll he's her here here's hers herself him himself his how how's i i'd
i'll i'm i've if in into is isn't it it's its itself just let's like lol me more most much my myself no nor not now of off
on once one only or other our ours ourselves out over own really same she she'd she'll she's should shouldn't so some still
such than that that's the their theirs them themselves then there there's these they they'd they'll they're they've this
those through to too under until up us very was wasn't we we'd we'll we're we've were weren't what what's when when's where
where's which while who who's whom why why's will with won't would wouldn't you you'd you'll you're you've your yours yourself
yourselves yeah yes yep nope ok okay im dont cant wont thats ive youre theyre isnt didnt doesnt gonna wanna gotta ur u r
people thing things something anything nothing everything someone anyone everyone way time day today going make made know
think see look want need come back even still also well much many every never always going right good great new old
first last long little big
bluesky bsky post posts posted posting thread threads repost reposts reply replies follow follows followers following feed
timeline skeet rt dm dms lmao lmfao rofl omg tbh imo imho idk idc smh wtf ngl fr af tho thx ty pls plz yall bruh nah yea yup huh
hey hi hello thanks thank please sorry congrats congratulations happy birthday welcome haha hahaha ha oh ah eh um uh aw ugh hmm
wow yay woo ready part parts easy easily say says said saying actually basically literally seriously honestly obviously
apparently probably definitely certainly maybe perhaps pretty quite rather simply totally completely absolutely especially
finally recently currently generally hopefully unfortunately usually already almost enough instead anyway anymore though
although however therefore either neither tomorrow yesterday tonight morning afternoon evening night week weekend month year
years months weeks days hours minutes seconds ago soon later early next getting gets goes went gone give gives given giving take
takes taking took taken put puts putting keep keeps kept let lets making makes use used uses using work works working worked
start starts started stop stops stopped turn turns turned call calls called help helps helped show shows showed shown run runs
running move moves moved live lives lived feel feels felt seem seems seemed find finds found try tries tried trying tell tells
told ask asks asked asking talk talks talking watch watches watching watched read reads reading write writes writing wrote saw
seen seeing love loves loved hate hates hope hopes wish wishes believe believes remember forget wait waiting looking looks
looked coming comes thinks thought thinking knows knew known wants wanted needs needed happen happens happened starting playing
saying having being happening might must shall couldnt wouldnt shouldnt havent hasnt arent werent wasnt lot lots plenty bunch
couple several stuff kind kinds sort sorts type types place places side sides end ends bit bits point points case cases fact
facts idea ideas reason reasons question questions answer answers problem problems guy guys folks man woman men women kid kids
friend friends family home house job life world times name names word words line lines story stories sure real true whole half
full two three four five six seven eight nine ten hundred thousand million billion second third via amp quot another others onto
upon without within around across along among behind toward towards near beyond despite unless whether hit hits mean means meant
exactly order orders outside inside`.split(/\s+/));

// Words that never open a name. Dropping a leading one keeps "The League Cup" at the
// start of a post and "the League Cup" mid-post on the same term.
const LEAD = new Set(`the a an and but or so then this that these those there here it its he she they we you i my your his her
their our what why how who which when where while if because as at in on for to of with from by about after before since than
too very is are was were do does did just also now not no yes yeah ok okay well oh hey`.split(/\s+/));

// Latin-1 letters are in: the firehose is not English-only, and splitting "eleição"
// at the accent invents junk terms.
const U = "A-Z\\u00C0-\\u00D6\\u00D8-\\u00DE";
const L = "a-z\\u00DF-\\u00F6\\u00F8-\\u00FF";
const WORD = new RegExp(`#?[${U}${L}][${U}${L}0-9'-]*`, "g");
const UPPER = new RegExp(`^[${U}]`);
const LOWER = new RegExp(`[${L}]`);
const ACRONYM = new RegExp(`^[${U}]{2,6}$`);
// The host is matched label by label rather than with \S+, which backtracks hard on
// a long dotted token and is the most expensive thing in this file when it does.
const URL = /https?:\/\/\S+|\b[\w-]+(?:\.[\w-]+)*\.(?:com|net|org|io|ai|app|co|gg|tv|dev|news|link)\b\S*/gi;
const HANDLE = /@[\w.-]+/g;
const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu;
// A link, handle or emoji leaves a break rather than a space: it ends a phrase, so
// the names on either side of it must not merge into one term.
const BREAK = " . ";

interface Tok {
  w: string;      // the word as written, minus the possessive
  lw: string;     // lowercased, with the # still on a hashtag
  hash: boolean;
  up: boolean;    // Capitalized, more than one letter: eligible for a proper-noun run
  shout: boolean; // no lowercase letters at all
  join: boolean;  // only spaces between this word and the one before it
  low: boolean;   // eligible for the bigram and unigram passes
  used: boolean;  // already spent inside a bigram
}

function tokenize(text: string): Tok[] {
  const clean = text.replace(/[\u2018\u2019]/g, "'").replace(URL, BREAK).replace(HANDLE, BREAK).replace(EMOJI, BREAK);
  const toks: Tok[] = [];
  let end = 0;
  WORD.lastIndex = 0;
  for (let m = WORD.exec(clean); m; m = WORD.exec(clean)) {
    const raw = m[0].replace(/'s$/, "").replace(/['-]+$/, "");
    const hash = raw[0] === "#";
    const w = hash ? raw.slice(1) : raw;
    const upper = !hash && UPPER.test(w);
    toks.push({
      w,
      lw: raw.toLowerCase(),
      hash,
      up: upper && w.length > 1,
      shout: upper && !LOWER.test(w),
      join: toks.length > 0 && /^[ \t]+$/.test(clean.slice(end, m.index)),
      low: !hash && !upper,
      used: false,
    });
    end = m.index + m[0].length;
  }
  return toks;
}

// Runs of adjacent Capitalized words are the densest signal a post has: people,
// teams, places, titles. A run of two or more always counts. A lone capitalized word
// counts only if it survives the stopword check, which is what keeps the "Ready" that
// merely started a sentence out of the cloud while "Denmark" stays in.
function phrases(toks: Tok[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < toks.length; i++) {
    if (!toks[i].up) continue;
    let j = i + 1;
    while (j < toks.length && toks[j].up && toks[j].join) j++;
    const run = toks.slice(i, j);
    i = j - 1;
    // Four or more shouted words is emphasis, not a name; hand them to the word passes.
    if (run.length > 3 && run.every((t) => t.shout)) {
      for (const t of run) t.low = true;
      continue;
    }
    let a = 0;
    let b = run.length;
    while (a < b && LEAD.has(run[a].lw)) a++;
    while (b > a && STOP.has(run[b - 1].lw)) b--;   // no name ends on a function word
    if (a < b) out.push(run.slice(a, Math.min(b, a + 3)).map((t) => t.lw).join(" "));
  }
  return out;
}

// A term is noise if it is too short, a bare number, or nothing but stopwords.
// Exported so consumers can filter terms they read back out of storage.
export function isNoise(term: string): boolean {
  const t = term.trim().toLowerCase();
  // Two letters is enough for an acronym (AI, UK, EU); anything shorter is punctuation.
  if (t.length < 2 || /^#?\d+$/.test(t)) return true;
  return t.replace(/^#/, "").split(" ").every((w) => STOP.has(w));
}

// Inside a shouted run adjacency is emphasis, not a phrase, so those words pair with nothing.
const pairable = (t: Tok) => t.low && !t.shout && t.w.length >= 2 && !STOP.has(t.lw);

export function extractTerms(text: string, cap = 12): string[] {
  const toks = tokenize(text);
  const out = new Set<string>();
  // A post that says both "#phoenix" and "Phoenix" means one thing, and letting both
  // through would spend two slots and draw an edge between a term and itself.
  const add = (t: string) => { if (!isNoise(t) && !out.has(`#${t}`)) out.add(t); };
  const room = () => out.size < cap;

  for (const t of toks) { if (!room()) break; if (t.hash) add(t.lw); }
  for (const p of phrases(toks)) { if (!room()) break; add(p); }   // also demotes shouted runs
  for (const t of toks) { if (!room()) break; if (t.shout && !t.low && ACRONYM.test(t.w)) add(t.lw); }
  for (let i = 0; i + 1 < toks.length && room(); i++) {
    if (!toks[i + 1].join || !pairable(toks[i]) || !pairable(toks[i + 1])) continue;
    add(`${toks[i].lw} ${toks[i + 1].lw}`);
    toks[i].used = toks[i + 1].used = true;
    i++;   // a word joins at most one bigram, so "a b c" yields "a b" and not "b c" too
  }
  for (const t of toks) { if (!room()) break; if (t.low && !t.used && t.lw.length >= 5) add(t.lw); }
  return [...out];
}
