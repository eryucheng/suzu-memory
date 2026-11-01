export function replaceQuotedText(value, replace) {
  // Chinese may touch a quote delimiter; apostrophes inside words stay intact.
  return String(value || '').replace(/[＂＇]/gu, quote => quote === '＂' ? '"' : "'").replace(
    /"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’|「[^」\n]*」|『[^』\n]*』|《[^》\n]*》|(?:(?<![\p{L}\p{N}_])|(?<=\p{Script=Han}))'(?=\S)[^\n]*?'(?:(?![\p{L}\p{N}_])|(?=\p{Script=Han}))/gu,
    replace,
  );
}

// Preserve UTF-16 offsets so grammar parsers can remove a matched span from
// the original query without dropping quoted topics or changing their text.
export function maskQuotedText(value) {
  return replaceQuotedText(value, quote => ' '.repeat(quote.length));
}

// A question can mention a preference without asserting that the speaker has
// it. Preserve quoted titles and statements alongside a question verbatim.
export function utteranceStatements(value) {
  const original = String(value || '');
  const grammar = maskQuotedText(original);
  let hasQuestion = false;
  const statements = [];
  const questions = [];
  for (const match of grammar.matchAll(/[^.!?。！？\n]+[.!?。！？]*/gu)) {
    if (/[?？]/u.test(match[0])) {
      hasQuestion = true;
      questions.push(original.slice(match.index, match.index + match[0].length));
    } else {
      statements.push(original.slice(match.index, match.index + match[0].length));
    }
  }
  return { hasQuestion, text: hasQuestion ? statements.join('\n') : original,
    questions: questions.join('\n') };
}

const REJECTED_REQUESTS = [
  /(^|[,;.!?:，。；！？]\s*|\b(?:but|instead)\s+)((?:please\s+)?(?:don't|do not|no need to)\s+(explain|quote|tell|show|list|give|include|provide|describe)\b)[^,;.!?:，。；！？]*?(?=$|[,;.!?:，。；！？]|\b(?:but|instead|just|rather)\b)/giu,
  /(^|[,;.!?:，。；！？]\s*)((?:请)?(?:不要|别|不用|不必|无需)(解释|引用|告诉|说|讲|分析|列出|展示))[^,;.!?:，。；！？]*?(?=$|[,;.!?:，。；！？]|而是|但是|但|只要|只想|只需)/gu,
  /(^|[,;.!?:，。；！？]\s*)(?:(?:i am|i'm)\s+)?not\s+(?:asking|talking|inquiring|referring)\b[^,;.!?:，。；！？]*?(?=$|[,;.!?:，。；！？]|\b(?:but|instead|just|rather)\b)/giu,
  /(^|[,;.!?:，。；！？]\s*)(?:我)?(?:不是|并非)(?:在)?(?:问|询问)[^,;.!?:，。；！？]*?(?=$|[,;.!?:，。；！？]|而是|但是|但|只要|只想|只需)/gu,
];
const REQUEST_CONNECTOR = /^(?:[\s,;.!?:，。；！？]+|\b(?:but|instead|just|rather)\b\s*|(?:而是|但是|但|只要|只想|只需)\s*)*/iu;

function foldGrammarCharacters(text) {
  return text.replace(/[！-～]/gu, character => String.fromCharCode(character.charCodeAt(0) - 0xFEE0))
    .replace(/’/gu, "'");
}

export function queryConnectorLength(text) {
  return foldGrammarCharacters(text).match(REQUEST_CONNECTOR)[0].length;
}

// Mask instructions without changing offsets or the spelling of requested
// topics. Quoted instructions and negated facts are not rejected requests.
export function maskRejectedRequests(value, { preserveReferences = false } = {}) {
  const text = String(value || '');
  let requested = text;
  const grammar = foldGrammarCharacters(maskQuotedText(text));
  for (const pattern of REJECTED_REQUESTS) for (const match of grammar.matchAll(pattern)) {
    const start = match.index + match[1].length;
    const reference = preserveReferences && ['explain', 'quote', '解释', '引用', '分析'].includes(match[3]?.toLowerCase());
    let end = reference ? start + match[2].length : match.index + match[0].length;
    // Inspect the original text so a quoted topic after the clause is kept.
    if (!reference) end += queryConnectorLength(text.slice(end));
    const blank = ' '.repeat(end - start);
    requested = `${requested.slice(0, start)}${blank}${requested.slice(end)}`;
  }
  return requested;
}
