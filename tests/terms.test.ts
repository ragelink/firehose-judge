import { describe, it, expect } from "vitest";
import { extractTerms, isNoise, STOP } from "../src/terms";

describe("hashtags", () => {
  it("keeps the hash, lowercases the tag, and ranks tags first", () => {
    expect(extractTerms("big night for #Arsenal and #premierLeague fans")).toEqual(["#arsenal", "#premierleague"]);
  });

  it("drops a hashtag that is only a stopword", () => {
    const terms = extractTerms("#lol #ok the Fastly outage took out half the web");
    expect(terms).not.toContain("#lol");
    expect(terms).not.toContain("#ok");
    expect(terms).toContain("fastly");
  });

  it("does not also emit the bare word the post hashtagged", () => {
    expect(extractTerms("#Arsenal are back. Arsenal really are back.")).toEqual(["#arsenal"]);
  });
});

describe("proper-noun phrases", () => {
  it("emits a multi-word name as one normalized term", () => {
    const terms = extractTerms("the referee gave Theo Walcott a yellow in the League Cup final");
    expect(terms).toContain("theo walcott");
    expect(terms).toContain("league cup");
    expect(terms).not.toContain("walcott");
    expect(terms).not.toContain("league");
  });

  it("keeps a single capitalized word that is not an ordinary word", () => {
    const terms = extractTerms("President Miller landed in Denmark");
    expect(terms).toContain("president miller");
    expect(terms).toContain("denmark");
    expect(terms).not.toContain("miller");
  });

  it("takes runs of up to three words", () => {
    expect(extractTerms("the New York City council met")).toContain("new york city");
    expect(extractTerms("filings from Royal Dutch Shell Board Meeting minutes")).toContain("royal dutch shell");
  });

  it("does not let punctuation or an emoji glue two names together", () => {
    expect(extractTerms("Arsenal 🔥 Chelsea")).toEqual(["arsenal", "chelsea"]);
    expect(extractTerms("I back Arsenal. Chelsea are done")).toEqual(["arsenal", "chelsea"]);
  });

  it("drops the trailing function word a name never ends on", () => {
    expect(extractTerms("Arsenal Are Back")).toEqual(["arsenal"]);
  });
});

describe("sentence-initial capitals", () => {
  it("skips a lone capital that is an ordinary word starting a sentence", () => {
    const terms = extractTerms("Ready for the League Cup final. Easily the best part of it.");
    expect(terms).not.toContain("ready");
    expect(terms).not.toContain("easily");
    expect(terms).toContain("league cup");
  });

  it("returns nothing for a post that is all filler", () => {
    expect(extractTerms("Part of me wants to say yes. Honestly, who knows.")).toEqual([]);
  });

  it("reads a leading article the same whether or not the sentence capitalized it", () => {
    expect(extractTerms("The League Cup starts tonight")).toEqual(extractTerms("well, the League Cup starts tonight"));
  });
});

describe("acronyms", () => {
  it("keeps all-caps tokens that are not stopwords", () => {
    const terms = extractTerms("the DOGE cuts hit the CDC, and the NFL is next");
    expect(terms).toContain("doge");
    expect(terms).toContain("cdc");
    expect(terms).toContain("nfl");
  });

  it("reads a long shouted run as prose, not as a name or an acronym", () => {
    expect(extractTerms("DENMARK WON THE WHOLE THING AND I AM NOT OKAY")).toEqual(["denmark"]);
    expect(extractTerms("SO MUCH FOR THAT")).toEqual([]);
  });

  // Two-letter acronyms lose to the three-character floor; "AI" still arrives as
  // "#ai" or inside a name like "OpenAI".
  it("keeps two-letter acronyms and the hashtag form", () => {
    expect(extractTerms("the UK and the EU")).toEqual(["uk", "eu"]);
    expect(extractTerms("#AI is eating the EU budget")).toEqual(expect.arrayContaining(["#ai", "eu"]));
  });
});

describe("bigrams", () => {
  it("pairs two lowercase words that both survive the stopword filter", () => {
    const terms = extractTerms("the new data centers are eating the grid");
    expect(terms).toContain("data centers");
    expect(terms).not.toContain("centers");
  });

  it("spends a word on at most one pair", () => {
    expect(extractTerms("moved onto bare metal servers")).toEqual(["bare metal", "servers"]);
  });

  it("will not pair across punctuation", () => {
    expect(extractTerms("nothing cheap. concrete costs more now")).not.toContain("cheap concrete");
  });
});

describe("stripping", () => {
  it("removes links, bare domains, handles and their fragments", () => {
    expect(extractTerms("read this https://theathletic.com/1234/story?x=1 now")).toEqual([]);
    expect(extractTerms("the docs are at fastly.dev/guides now")).toEqual([]);
    const reply = extractTerms("@leo.bsky.social said the Champions League draw is rigged");
    expect(reply).toContain("champions league");
    expect(reply.join(" ")).not.toMatch(/leo|social/);
  });

  it("removes the possessive and bare numbers", () => {
    expect(extractTerms("Theo Walcott's hat-trick")).toContain("theo walcott");
    expect(extractTerms("we counted 2026 birds")).not.toContain("2026");
  });

  it("drops anything under two characters", () => {
    expect(extractTerms("a cat on a mat")).toEqual([]);
    for (const t of extractTerms("the UN and the WHO and the CDC met")) expect(t.length).toBeGreaterThanOrEqual(2);
  });
});

describe("the cap", () => {
  const post = "President Miller met the Danish PM in Copenhagen about the NATO summit, the DOGE cuts, "
    + "vaccine surveillance, pedestrian deaths, data centers and the League Cup final #uspol #nato";

  it("stops at the cap and spends it on the strongest terms first", () => {
    expect(extractTerms(post, 3)).toEqual(["#uspol", "#nato", "president miller"]);
    expect(extractTerms(post, 1)).toEqual(["#uspol"]);
    expect(extractTerms(post, 0)).toEqual([]);
  });

  it("defaults to twelve", () => {
    expect(extractTerms(post)).toHaveLength(12);
    expect(extractTerms(post)).toEqual(extractTerms(post, 12));
  });
});

describe("determinism", () => {
  const post = "Theo Walcott scored in the League Cup and the DOGE cuts hit the CDC #uspol";

  it("returns the same terms every call, including after other posts", () => {
    const first = extractTerms(post);
    for (let i = 0; i < 5; i++) {
      extractTerms("something else entirely with #other tags and OTHER acronyms");
      expect(extractTerms(post)).toEqual(first);
    }
  });

  it("never returns a duplicate", () => {
    const terms = extractTerms("Arsenal Arsenal arsenal #arsenal ARSENAL arsenal fans");
    expect(new Set(terms).size).toBe(terms.length);
  });
});

describe("real posts", () => {
  const posts: [string, string[]][] = [
    [
      "Ready for the League Cup final tonight. Theo Walcott is on the bench for Arsenal again, "
        + "which tells you everything about how this season has gone.",
      ["league cup", "theo walcott", "arsenal", "final", "bench", "season"],
    ],
    [
      "President Miller signed it this morning. The CDC says the DOGE cuts will hit vaccine "
        + "surveillance first, and the NIH is next. #uspol",
      ["#uspol", "president miller", "cdc", "doge", "nih", "vaccine surveillance", "signed"],
    ],
    [
      "wrote up how we moved off the old data centers and onto bare metal, with numbers "
        + "https://blog.example.com/bare-metal?ref=bsky #devops #infrastructure",
      ["#devops", "#infrastructure", "data centers", "bare metal", "numbers"],
    ],
    [
      "honestly the pedestrian crossing outside my building has been broken for a month and "
        + "nobody at the city wants to say who owns it",
      ["pedestrian crossing", "building", "broken", "nobody"],
    ],
    [
      "@leo.bsky.social this is exactly what i meant about the Champions League draw 😂🔥 "
        + "Real Madrid get another walkover",
      ["champions league", "real madrid", "walkover"],
    ],
    ["macro: RlQiQfynrFjvsuEVyQbY", ["rlqiqfynrfjvsuevyqby", "macro"]],
    ["eleição no Brasil: Lula falou sobre a economia hoje", ["brasil", "lula", "falou sobre", "economia hoje", "eleição"]],
  ];

  it.each(posts)("reads %s", (text, expected) => {
    expect(extractTerms(text)).toEqual(expected);
  });

  it("never emits a term it would itself call noise", () => {
    for (const [text] of posts) for (const t of extractTerms(text)) expect(isNoise(t)).toBe(false);
  });
});

describe("isNoise", () => {
  it("rejects short, numeric and stopword-only terms", () => {
    for (const t of ["", "a", "  ok  ", "lol", "the", "2026", "#2026", "bluesky", "rt"]) {
      expect(isNoise(t)).toBe(true);
    }
  });

  it("accepts hashtags, acronyms, words and phrases that carry meaning", () => {
    for (const t of ["#ai", "ai", "uk", "doge", "denmark", "data centers", "theo walcott", "new york city"]) {
      expect(isNoise(t)).toBe(false);
    }
  });
});

describe("STOP", () => {
  it("covers function words and the Bluesky-isms", () => {
    for (const w of ["the", "really", "ready", "part", "easily", "say", "bluesky", "bsky", "post", "posts",
      "thread", "repost", "follow", "followers", "lol", "lmao", "omg", "tbh", "imo", "rt"]) {
      expect(STOP.has(w)).toBe(true);
    }
  });
});

describe("cost", () => {
  it("stays under 0.2ms for a full-length post", () => {
    const post = "Ready for the League Cup final. Theo Walcott is starting for Arsenal, and President Miller "
      + "said the DOGE cuts hit the CDC this week, which is easily the most absurd part of the whole thing. "
      + "Say what you want about the man, he is not wrong about any of it, and the NHS numbers back him up #football";
    expect(post.length).toBeGreaterThan(280);
    for (let i = 0; i < 2000; i++) extractTerms(post);   // warm
    const started = Date.now();
    for (let i = 0; i < 2000; i++) extractTerms(post);
    expect((Date.now() - started) / 2000).toBeLessThan(0.2);
  });
});
