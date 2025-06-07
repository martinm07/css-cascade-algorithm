declare module "@bramus/specificity" {
  export default class Specificity {
    static calculate(selector: string | CSSTreeAST): Array<Specificity>;
    static calculateForAST(selectorAST: CSSTreeAST): Specificity;
    static compare(
      s1: SpecificityInstanceOrObject,
      s2: SpecificityInstanceOrObject
    ): number;
    static equals(
      s1: SpecificityInstanceOrObject,
      s2: SpecificityInstanceOrObject
    ): boolean;
    static lessThan(
      s1: SpecificityInstanceOrObject,
      s2: SpecificityInstanceOrObject
    ): boolean;
    static greaterThan(
      s1: SpecificityInstanceOrObject,
      s2: SpecificityInstanceOrObject
    ): boolean;
    static min(
      ...specificities: SpecificityInstanceOrObject[]
    ): SpecificityInstanceOrObject;
    static max(
      ...specificities: SpecificityInstanceOrObject[]
    ): SpecificityInstanceOrObject;
    static sortAsc(
      ...specificities: SpecificityInstanceOrObject[]
    ): SpecificityInstanceOrObject;
    static sortDesc(
      ...specificities: SpecificityInstanceOrObject[]
    ): SpecificityInstanceOrObject;
    constructor(value: SpecificityObject, selector?: any);
    value: SpecificityObject;
    selector: string | CSSTreeAST;
    set a(arg: number);
    get a(): number;
    set b(arg: number);
    get b(): number;
    set c(arg: number);
    get c(): number;
    selectorString(): string;
    toObject(): SpecificityObject;
    toArray(): SpecificityArray;
    toString(): string;
    toJSON(): {
      selector: string;
      asObject: SpecificityObject;
      asArray: SpecificityArray;
      asString: string;
    };
    isEqualTo(otherSpecificity: SpecificityInstanceOrObject): boolean;
    isGreaterThan(otherSpecificity: SpecificityInstanceOrObject): boolean;
    isLessThan(otherSpecificity: SpecificityInstanceOrObject): boolean;
  }
}

declare module "css-shorthand-properties" {
  export function isShorthand(property: string): boolean;
  export function expand(property: string, recurse: false): string[];
  export function expand(property: string, recurse: true): string[][];
}
