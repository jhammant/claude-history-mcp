/**
 * Inline Porter stemmer for English.
 * Implements the main steps of the Porter stemming algorithm.
 */

const step2list: Record<string, string> = {
  ational: "ate", tional: "tion", enci: "ence", anci: "ance",
  izer: "ize", bli: "ble", alli: "al", entli: "ent",
  eli: "e", ousli: "ous", ization: "ize", ation: "ate",
  ator: "ate", alism: "al", iveness: "ive", fulness: "ful",
  ousness: "ous", aliti: "al", iviti: "ive", biliti: "ble",
  logi: "log",
};

const step3list: Record<string, string> = {
  icate: "ic", ative: "", alize: "al", iciti: "ic",
  ical: "ic", ful: "", ness: "",
};

const c = "[^aeiou]";
const v = "[aeiouy]";
const C = c + "[^aeiouy]*";
const V = v + "[aeiou]*";
const mgr0 = new RegExp("^(" + C + ")?" + V + C);
const meq1 = new RegExp("^(" + C + ")?" + V + C + "(" + V + ")?$");
const mgr1 = new RegExp("^(" + C + ")?" + V + C + V + C);
const s_v = new RegExp("^(" + C + ")?" + v);

export function stem(word: string): string {
  if (word.length < 3) return word;

  let firstch: string | undefined;
  if (word[0] === "y") {
    firstch = "Y";
    word = "Y" + word.slice(1);
  }

  // Step 1a
  let re = /^(.+?)(ss|i)es$/;
  let re2 = /^(.+?)([^s])s$/;
  if (re.test(word)) word = word.replace(re, "$1$2");
  else if (re2.test(word)) word = word.replace(re2, "$1$2");

  // Step 1b
  re = /^(.+?)eed$/;
  re2 = /^(.+?)(ed|ing)$/;
  if (re.test(word)) {
    const fp = re.exec(word)!;
    if (mgr0.test(fp[1])) word = word.slice(0, -1);
  } else if (re2.test(word)) {
    const fp = re2.exec(word)!;
    const stem = fp[1];
    if (s_v.test(stem)) {
      word = stem;
      const re3 = /(at|bl|iz)$/;
      const re4 = /([^aeiouylsz])\1$/;
      const re5 = new RegExp("^" + C + v + "[^aeiouwxy]$");
      if (re3.test(word)) word += "e";
      else if (re4.test(word)) word = word.slice(0, -1);
      else if (re5.test(word)) word += "e";
    }
  }

  // Step 1c
  re = /^(.+?)y$/;
  if (re.test(word)) {
    const fp = re.exec(word)!;
    if (s_v.test(fp[1])) word = fp[1] + "i";
  }

  // Step 2
  re = /^(.+?)(ational|tional|enci|anci|izer|bli|alli|entli|eli|ousli|ization|ation|ator|alism|iveness|fulness|ousness|aliti|iviti|biliti|logi)$/;
  if (re.test(word)) {
    const fp = re.exec(word)!;
    if (mgr0.test(fp[1])) word = fp[1] + step2list[fp[2]];
  }

  // Step 3
  re = /^(.+?)(icate|ative|alize|iciti|ical|ful|ness)$/;
  if (re.test(word)) {
    const fp = re.exec(word)!;
    if (mgr0.test(fp[1])) word = fp[1] + step3list[fp[2]];
  }

  // Step 4
  re = /^(.+?)(al|ance|ence|er|ic|able|ible|ant|ement|ment|ent|ou|ism|ate|iti|ous|ive|ize)$/;
  re2 = /^(.+?)(s|t)(ion)$/;
  if (re.test(word)) {
    const fp = re.exec(word)!;
    if (mgr1.test(fp[1])) word = fp[1];
  } else if (re2.test(word)) {
    const fp = re2.exec(word)!;
    const stem = fp[1] + fp[2];
    if (mgr1.test(stem)) word = stem;
  }

  // Step 5
  re = /^(.+?)e$/;
  if (re.test(word)) {
    const fp = re.exec(word)!;
    const re3 = new RegExp("^" + C + v + "[^aeiouwxy]$");
    if (mgr1.test(fp[1]) || (meq1.test(fp[1]) && !re3.test(fp[1])))
      word = fp[1];
  }
  re = /ll$/;
  if (re.test(word) && mgr1.test(word)) word = word.slice(0, -1);

  if (firstch === "Y") word = word[0].toLowerCase() + word.slice(1);

  return word;
}
