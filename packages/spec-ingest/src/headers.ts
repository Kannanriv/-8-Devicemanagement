/** Fuzzy column-header classification for OEM field tables. */

export type Role =
  | "pos"
  | "offset" // ambiguous: byte position, or value offset when another position column exists
  | "length"
  | "bitpos"
  | "bits" // ambiguous: width, or position when the value is a range
  | "bitlen"
  | "name"
  | "key"
  | "type"
  | "unit"
  | "scale"
  | "voffset"
  | "range"
  | "min"
  | "max"
  | "desc"
  | "values"
  | "example"
  | "default"
  | "register"
  | "endian";

const RULES: [Role, RegExp][] = [
  ["key", /^(json ?(key|name|field|tag)?|key|tag|variable( name)?|identifier|property|output ?(key|name)|object ?key|field ?id|attribute|api ?name)$/],
  ["bitlen", /^((bit ?(len|length|width|size|count))|((len|size|width|length) ?\(?bits?\)?)|(no\.? ?of ?bits)|(num ?bits))$/],
  ["bits", /^bits$/],
  ["bitpos", /^(bit ?\(s\)|bit|bit ?(pos|position|no\.?|index|#|range|offset|mask)|bits ?(pos|position|range))$/],
  ["offset", /^offset$/],
  ["length", /^(len|length|size|bytes|byte ?\(s\)|byte ?(len|length|count|size|num)|no\.? ?of ?bytes|num ?bytes|(size|length|len) ?\(?(bytes?|b|octets?)\)?|width|octets)$/],
  ["pos", /^((start ?)?(byte|octet)( ?(no\.?|#|index|offset|pos|position|addr|address|number|nr))?|pos|position|start|byte ?offset|offset ?\(?(bytes?|byte ?pos)\)?|addr|address|idx|index|payload ?offset|byte ?pos|frame ?offset|data ?offset|#)$/],
  ["voffset", /^(value ?offset|add|addend|bias|offset ?value|zero ?offset|offset ?\(?value\)?)$/],
  ["name", /^(field|field ?name|parameter|param|name|signal|signal ?name|item|content|data ?item|element|measurement|quantity|parameter ?name|data ?name|data ?field|data|channel|register ?name|variable ?description)$/],
  ["type", /^(type|data ?type|datatype|format|data ?format|encoding|value ?type|dtype|var ?type|data ?type ?\/ ?format|format ?\/ ?type)$/],
  ["unit", /^(unit|units|uom|unit of measure|eng\.? ?unit)$/],
  ["scale", /^(scale|scaling|resolution|factor|multiplier|ratio|coefficient|coef|gain|lsb|scale ?factor|conversion|scaling ?factor|precision)$/],
  ["range", /^(range|valid ?range|value ?range|measuring ?range|limits|measurement ?range)$/],
  ["min", /^(min|minimum|min ?value|lower ?limit|low)$/],
  ["max", /^(max|maximum|max ?value|upper ?limit|high)$/],
  ["desc", /^(description|desc|remark|remarks|notes?|comments?|meaning|details|explanation|definition|info)$/],
  ["values", /^(values?|enum|enumeration|value ?description|states?|options|mapping|codes?|value ?meaning|value ?map|possible ?values|value ?definition|status ?codes?)$/],
  ["example", /^(example|sample|example ?value|e\.?g\.?|test ?value|sample ?value|typical)$/],
  ["default", /^(default|default ?value)$/],
  ["register", /^(register|reg|register ?\(hex\)|modbus ?(register|address|reg|addr)|reg(ister)? ?addr(ess)?|holding ?register)$/],
  ["endian", /^(endian|endianness|byte ?order)$/],
];

export function normHeader(text: string): string {
  return text
    .toLowerCase()
    .replace(/\n/g, " ")
    .replace(/[_*:]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s*\(\s*/g, " (")
    .replace(/\s*\)\s*/g, ")")
    .trim();
}

export function classifyHeader(text: string): Role | undefined {
  const h = normHeader(text);
  if (!h || h.length > 40) return undefined;
  for (const [role, re] of RULES) if (re.test(h)) return role;
  // "Length (bytes)", "Field Name / Description" style fallbacks
  const first = h.split(/[\s/]+/)[0]!;
  for (const [role, re] of RULES) if (role !== "bits" && role !== "offset" && re.test(first)) return role;
  return undefined;
}

export type ColumnMap = Partial<Record<Role, number>>;

/** Returns the column map if `row` looks like a field-table header. */
export function detectHeader(row: string[]): ColumnMap | undefined {
  const cols: ColumnMap = {};
  let hits = 0;
  row.forEach((cell, c) => {
    if (!cell) return;
    const role = classifyHeader(cell);
    if (!role || cols[role] !== undefined) return;
    cols[role] = c;
    hits++;
  });
  if (cols.name === undefined && cols.key === undefined) return undefined;
  const layout = ["pos", "offset", "length", "bitpos", "bits", "bitlen", "type", "register"].some((r) => cols[r as Role] !== undefined);
  if (!layout || hits < 2) return undefined;
  // resolve ambiguous "offset"
  if (cols.offset !== undefined) {
    if (cols.pos !== undefined) {
      if (cols.voffset === undefined) cols.voffset = cols.offset;
    } else cols.pos = cols.offset;
    delete cols.offset;
  }
  if (cols.key !== undefined && cols.name === undefined) cols.name = cols.key;
  return cols;
}
