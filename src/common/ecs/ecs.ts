
// entity scopes contain entities, and are nested
// also contain segments (code, bss, rodata)
// components and systems are global
// component fields are stored in arrays, range of entities, can be bit-packed
// some values can be constant, are stored in rodata (or loaded immediate)
//
// systems receive and send events, execute code on entities
// systems are generated on a per-scope basis
// system queries can only contain entities from self and parent scopes
// starting from the 'init' event walk the event tree
// include systems that have at least 1 entity in scope (except init?)
//
// when entering scope, entities are initialized (zero or init w/ data)
// to change scope, fire event w/ scope name
// - how to handle bank-switching?

function mksymbol(c: ComponentType, fieldName: string) {
    return c.name + '_' + fieldName;
}

export interface Entity {
    id: number;
    etype: EntityArchetype;
    consts: {[name: string]: DataValue};
}

export interface EntityConst {
    component: ComponentType;
    name: string;
    value: DataValue;
}

export interface EntityArchetype {
    components: ComponentType[];
}

export interface ComponentType {
    name: string;
    fields: DataField[];
    optional?: boolean;
}

export interface Query {
    include: string[];
    listen?: string[];
    exclude?: string[];
    updates?: string[];
}

export interface System {
    name: string;
    actions: CodeFragment[];
    query: Query;
    tempbytes?: number;
    emits?: string[];
    live?: EntityArchetype[] | null;
}

export interface CodeFragment {
    text: string;
    event: string;
    iterate: 'once' | 'each'
}

export type DataValue = number | boolean | Uint8Array;

export type DataField = { name: string } & DataType;

export type DataType = IntType | ArrayType | RefType;

export interface IntType {
    dtype: 'int'
    lo: number
    hi: number
}

export interface ArrayType {
    dtype: 'array'
    elem: DataType
    index?: DataType
}

export interface RefType {
    dtype: 'ref'
    query: Query
}

interface FieldArray {
    component: ComponentType;
    field: DataField;
    elo: number;
    ehi: number;
    access?: FieldAccess[];
}

interface FieldAccess {
    symbol: string;
    bit: number;
    width: number;
}

interface ConstByte {
    symbol: string;
    bitofs: number;
}

interface ArchetypeMatch {
    etype: EntityArchetype;
    cmatch: ComponentType[];
}

class SourceFileExport {
    lines : string[] = [];

    comment(text: string) {
        this.lines.push(';' + text);
    }
    segment(seg: string, segtype: 'rodata' | 'bss') {
        if (segtype == 'bss') {
            this.lines.push(` seg.u ${seg}`);
            this.lines.push(` org $80`); // TODO
        } else {
            this.lines.push(` seg ${seg}`);
            this.lines.push(` org $f000`); // TODO
        }
    }
    label(sym: string) {
        this.lines.push(`${sym}:`);
    }
    byte(b: number | ConstByte | undefined) {
        if (b === undefined) {
            this.lines.push(` .ds 1`);
        } else if (typeof b === 'number') {
            if (b < 0 || b > 255) throw new Error(`out of range byte ${b}`);
            this.lines.push(` .byte ${b}`)
        } else {
            this.lines.push(` .byte (${b.symbol} >> ${b.bitofs})`)
        }
    }
    text(s: string) {
        for (let l of s.split('\n'))
            this.lines.push(l);
    }
    toString() {
        return this.lines.join('\n');
    }
}

class Segment {
    symbols: {[sym: string]: number} = {};
    ofs2sym = new Map<number,string[]>();
    fieldranges: {[cfname: string]: FieldArray} = {};
    size: number = 0;
    initdata: (number | ConstByte | undefined)[] = [];
    codefrags : string[] = [];

    addCodeFragment(code: string) {
        this.codefrags.push(code);
    }
    allocateBytes(name: string, bytes: number) {
        if (this.symbols[name]) return this.symbols[name]; // TODO: check size
        let ofs = this.size;
        this.symbols[name] = ofs;
        if (!this.ofs2sym.has(ofs))
            this.ofs2sym.set(ofs, []);
        this.ofs2sym.get(ofs)?.push(name);
        this.size += bytes;
        return ofs;
    }
    // TODO: optimize shared data
    allocateInitData(name: string, bytes: Uint8Array) {
        let ofs = this.allocateBytes(name, bytes.length);
        for (let i=0; i<bytes.length; i++) {
            this.initdata[ofs + i] = bytes[i];
        }
    }
    dump(file: SourceFileExport) {
        for (let code of this.codefrags) {
            file.text(code);
        }
        for (let i=0; i<this.size; i++) {
            let syms = this.ofs2sym.get(i);
            if (syms) {
                for (let sym of syms) file.label(sym);
            }
            file.byte(this.initdata[i]);
        }
    }
    // TODO: move cfname functions in here too
    getFieldRange(component: ComponentType, fieldName: string) {
        return this.fieldranges[mksymbol(component, fieldName)];
    }
}

function getFieldBits(f: IntType) {
    let n = f.hi - f.lo + 1;
    return Math.ceil(Math.log2(n));
}

function getPackedFieldSize(f: DataType, constValue?: DataValue): number {
    if (f.dtype == 'int') {
        return getFieldBits(f);
    } if (f.dtype == 'array' && f.index) {
        return getPackedFieldSize(f.index) * getPackedFieldSize(f.elem);
    } if (f.dtype == 'array' && constValue != null && Array.isArray(constValue)) {
        return constValue.length * getPackedFieldSize(f.elem);
    } if (f.dtype == 'ref') {
        return 8; // TODO: > 256 entities?
    }
    return 0;
}

const ASM_ITERATE_EACH = `
    ldx #0
%{.loop}:
    %{code}
    inx
    cpx #%{ecount}
    bne %{.loop}
`;

export class EntityScope {
    childScopes : EntityScope[] = [];
    entities : Entity[] = [];
    bss = new Segment();
    rodata = new Segment();
    code = new Segment();
    componentsInScope = new Set();
    tempOffset = 0;
    maxTempBytes = 0;
    subroutines = new Set<string>();

    constructor(
        public readonly em: EntityManager,
        public readonly name: string,
        public readonly parent: EntityScope | undefined
    ) {
        parent?.childScopes.push(this);
    }
    newEntity(etype: EntityArchetype) : Entity {
        // TODO: add parent ID? lock parent scope?
        let id = this.entities.length;
        let entity : Entity = {id, etype, consts:{}};
        this.em.archtypes.add(etype);
        for (let c of etype.components) {
            this.componentsInScope.add(c.name);
        }
        this.entities.push(entity);
        return entity;
    }
    *iterateFields() {
        for (let i=0; i<this.entities.length; i++) {
            let e = this.entities[i];
            for (let c of e.etype.components) {
                for (let f of c.fields) {
                    yield {i, e, c, f, v:e.consts[mksymbol(c, f.name)]};
                }
            }
        }
    }
    buildSegments() {
        let iter = this.iterateFields();
        for (var o=iter.next(); o.value; o=iter.next()) {
            let {i,e,c,f,v} = o.value;
            let segment = v === undefined ? this.bss : this.rodata;
            let cfname = mksymbol(c, f.name);
            let array = segment.fieldranges[cfname];
            if (!array) {
                array = segment.fieldranges[cfname] = {component:c, field:f, elo:i, ehi:i};
            } else {
                array.ehi = i;
            }
            //console.log(i,array,cfname);
        }
    }
    allocateSegment(segment: Segment, readonly: boolean) {
        let fields = Object.values(segment.fieldranges);
        fields.sort((a,b) => (a.ehi - a.elo + 1) * getPackedFieldSize(a.field));
        let f;
        while (f = fields.pop()) {
            let name = mksymbol(f.component, f.field.name);
            // TODO: doesn't work for packed arrays too well
            let bits = getPackedFieldSize(f.field);
            // variable size? make it a pointer
            if (bits == 0) bits = 16; // TODO?
            let rangelen = (f.ehi - f.elo + 1);
            let bytesperelem = Math.ceil(bits/8) * rangelen;
            // TODO: packing bits
            // TODO: split arrays
            f.access = [];
            for (let i=0; i<bits; i+=8) {
                let symbol = name + '_b' + i;
                f.access.push({symbol, bit:0, width:8}); // TODO
                if (!readonly) {
                    segment.allocateBytes(symbol, rangelen * bytesperelem); // TODO
                }
            }
        }
    }
    allocateROData(segment: Segment) {
        let iter = this.iterateFields();
        for (var o=iter.next(); o.value; o=iter.next()) {
            let {i,e,c,f,v} = o.value;
            let cfname = mksymbol(c, f.name);
            let fieldrange = segment.fieldranges[cfname];
            if (v !== undefined) {
                // is it a byte array?
                if (v instanceof Uint8Array) {
                    let datasym = `${c.name}_${f.name}_e${e.id}`;
                    let ptrlosym = `${c.name}_${f.name}_b0`;
                    let ptrhisym = `${c.name}_${f.name}_b8`;
                    let entcount = fieldrange.ehi - fieldrange.elo + 1;
                    segment.allocateInitData(datasym, v);
                    let loofs = segment.allocateBytes(ptrlosym, entcount);
                    let hiofs = segment.allocateBytes(ptrhisym, entcount);
                    segment.initdata[loofs + e.id - fieldrange.elo] = {symbol:datasym, bitofs:0};
                    segment.initdata[hiofs + e.id - fieldrange.elo] = {symbol:datasym, bitofs:8};
                } else if (fieldrange.ehi > fieldrange.elo) {
                    // more than one element, add an array
                    // TODO
                }
                //console.log(cfname, i, v, fieldrange);
                //segment.allocateInitData(cfname, );
            }
        }
        //console.log(segment.initdata)
    }
    setConstValue(e: Entity, component: ComponentType, fieldName: string, value: DataValue) {
        // TODO: check to make sure component exists
        e.consts[mksymbol(component, fieldName)] = value;
    }
    generateCodeForEvent(event: string): string {
        // find systems that respond to event
        // and have entities in this scope
        let systems = this.getSystems([event]);
        if (systems.length == 0) {
            console.log(`; warning: no system responds to ${event}`); // TODO: warning
        }
        let s = '';
        //s += `\n; event ${event}\n`;
        let emitcode : {[event: string] : string} = {};
        for (let sys of systems) {
            if (sys.tempbytes) this.allocateTempBytes(sys.tempbytes);
            if (sys.emits) {
                for (let emit of sys.emits) {
                    if (emitcode[emit]) {
                        console.log(`already emitted for ${sys.name}:${event}`);
                    }
                    //console.log('>', emit);
                    // TODO: cycles
                    emitcode[emit] = this.generateCodeForEvent(emit);
                    //console.log('<', emit, emitcode[emit].length);
                }
            }
            if (sys.tempbytes) this.allocateTempBytes(-sys.tempbytes);
            for (let action of sys.actions) {
                if (action.event == event) {
                    let code = this.replaceCode(action.text, sys, action);
                    s += `\n; <action ${sys.name}:${event}>\n`;
                    s += code;
                    s += `\n; </action ${sys.name}:${event}>\n`;
                    // TODO: check that this happens once?
                }
            }
        }
        return s;
    }
    allocateTempBytes(n: number) {
        this.tempOffset += n;
        this.maxTempBytes = Math.max(this.tempOffset, this.maxTempBytes);
    }
    replaceCode(code: string, sys: System, action: CodeFragment): string {
        const re = /\%\{(.+?)\}/g;
        let label = sys.name + '_' + action.event;
        let atypes = this.em.archetypesMatching(sys.query);
        let entities = this.entitiesMatching(atypes);
        // TODO: find loops
        if (action.iterate == 'each') {
            code = this.wrapCodeInLoop(code, sys, action, entities);
            //console.log(sys.name, action.event, ents);
            //frag = this.iterateCode(frag);
        }
        return code.replace(re, (entire, group: string) => {
            let cmd = group.charAt(0);
            let rest = group.substring(1);
            switch (cmd) {
                case '!': // emit event
                    return this.generateCodeForEvent(rest);
                case '.': // auto label
                    return `.${label}_${rest}`;
                case '$': // temp byte
                    return `TEMP+${this.tempOffset}+${rest}`;
                case '<': // low byte
                    return this.generateCodeForField(sys, action, atypes, entities, rest, 0);
                case '>': // high byte
                    return this.generateCodeForField(sys, action, atypes, entities, rest, 8);
                case '^': // reference
                    return this.includeSubroutine(rest);
                default:
                    //throw new Error(`unrecognized command ${cmd} in ${entire}`);
                    console.log(`unrecognized command ${cmd} in ${entire}`);
                    return entire;
            }
        });
    }
    includeSubroutine(symbol: string): string {
        this.subroutines.add(symbol);
        return symbol;
    }
    wrapCodeInLoop(code: string, sys: System, action: CodeFragment, ents: Entity[]): string {
        // TODO: check ents
        // TODO: check segment bounds
        let s = ASM_ITERATE_EACH;
        s = s.replace('%{elo}', ents[0].id.toString());
        s = s.replace('%{ehi}', ents[ents.length-1].id.toString());
        s = s.replace('%{ecount}', ents.length.toString());
        s = s.replace('%{code}', code);
        return s;
    }
    generateCodeForField(sys: System, action: CodeFragment, 
        atypes: ArchetypeMatch[], entities: Entity[],
        fieldName: string, bitofs: number): string {
        // find archetypes
        let component = this.em.componentWithFieldName(atypes, fieldName);
        if (!component) {
            throw new Error(`cannot find component with field "${fieldName}" in ${sys.name}:${action.event}`);
        }
        // see if all entities have the same constant value
        let constValues = new Set();
        for (let e of entities) {
            let constVal = e.consts[fieldName];
            if (constVal) constValues.add(constVal);
        }
        // TODO: offset > 0?
        //let range = this.bss.getFieldRange(component, fieldName);
        return `${component.name}_${fieldName}_b${bitofs},x`
    }
    entitiesMatching(atypes: ArchetypeMatch[]) {
        let result = [];
        for (let e of this.entities) {
            for (let a of atypes) {
                // TODO: what about subclasses?
                if (e.etype == a.etype) {
                    result.push(e);
                    break;
                }
            }
        }
        return result;
    }
    getSystems(events: string[]) {
        let result = [];
        for (let sys of Object.values(this.em.systems)) {
            if (this.systemListensTo(sys, events)) {
                result.push(sys);
            }
        }
        return result;
    }
    systemListensTo(sys: System, events: string[]) {
        for (let action of sys.actions) {
            if (action.event != null && events.includes(action.event)) {
                let archs = this.em.archetypesMatching(sys.query);
                for (let arch of archs) {
                    for (let ctype of arch.cmatch) {
                        if (this.hasComponent(ctype)) {
                            return true;
                        }
                    }
                }
            }
        }
    }
    hasComponent(ctype: ComponentType) {
        return this.componentsInScope.has(ctype.name);
    }
    analyzeEntities() {
        this.buildSegments();
        this.allocateSegment(this.bss, false);
        this.allocateSegment(this.rodata, true);
        this.allocateROData(this.rodata);
    }
    generateCode() {
        this.tempOffset = this.maxTempBytes = 0;
        let init = this.generateCodeForEvent('init');
        this.code.addCodeFragment(init);
        for (let sub of Array.from(this.subroutines.values())) {
            let code = this.generateCodeForEvent(sub);
            this.code.addCodeFragment(code);
        }
    }
    dump(file: SourceFileExport) {
        file.text(HEADER); // TODO
        file.segment(`${this.name}_DATA`, 'bss');
        if (this.maxTempBytes) this.bss.allocateBytes('TEMP', this.maxTempBytes);
        this.bss.dump(file);
        file.segment(`${this.name}_CODE`, 'rodata');
        this.rodata.dump(file);
        this.code.dump(file);
        file.text(FOOTER); // TODO
    }
}

export class EntityManager {
    archtypes = new Set<EntityArchetype>();
    components : {[name: string]: ComponentType} = {};
    systems : {[name: string]: System} = {};
    scopes : {[name: string]: EntityScope} = {};

    newScope(name: string, parent?: EntityScope) {
        let scope = new EntityScope(this, name, parent);
        if (this.scopes[name]) throw new Error(`scope ${name} already defined`);
        this.scopes[name] = scope;
        return scope;
    }
    defineComponent(ctype: ComponentType) {
        if (this.components[ctype.name]) throw new Error(`component ${name} already defined`);
        return this.components[ctype.name] = ctype;
    }
    defineSystem(system: System) {
        if (this.systems[system.name]) throw new Error(`system ${name} already defined`);
        this.systems[system.name] = system;
    }
    componentsMatching(q: Query, etype: EntityArchetype) {
        let list = [];
        for (let c of etype.components) {
            let cname = c.name;
            // TODO: 0 includes == all entities?
            if (q.include.length == 0 || q.include.includes(cname)) {
                if (!q.exclude?.includes(cname)) {
                    list.push(c);
                }
            }
        }
        return list;
    }
    archetypesMatching(q: Query) {
        let result : ArchetypeMatch[] = [];
        this.archtypes.forEach(etype => {
            let cmatch = this.componentsMatching(q, etype);
            if (cmatch.length > 0) {
                result.push({etype, cmatch});
            }
        });
        return result;
    }
    componentWithFieldName(atypes: ArchetypeMatch[], fieldName: string) {
        // TODO???
        for (let at of atypes) {
            for (let c of at.cmatch) {
                for (let f of c.fields) {
                    if (f.name == fieldName)
                        return c;
                }
            }
        }
    }
}

///

const HEADER = `
    processor 6502
    include "vcs.h"
    include "macro.h"
    include "xmacro.h"
`

const FOOTER = `
    org $fffc
    .word Start	; reset vector
    .word Start	; BRK vector
`

const TEMPLATE_INIT = `
Start:
    CLEAN_START
    %{!start}
`

const TEMPLATE1 = `
.NextFrame:
	VERTICAL_SYNC
    sta CXCLR	; clear collision register
    IFCONST PAL
        TIMER_SETUP 44
    ELSE
        TIMER_SETUP 36
    ENDIF

    %{!preframe}

    TIMER_WAIT
	lda #0
    sta VBLANK
    IFNCONST PAL
        TIMER_SETUP 194
    ENDIF

    %{!kernel}

    IFNCONST PAL
        TIMER_WAIT
    ENDIF
    lda #2
    sta VBLANK
    IFCONST PAL
        TIMER_SETUP 36
    ELSE
        TIMER_SETUP 28
    ENDIF

    %{!postframe}

    TIMER_WAIT
    lsr SWCHB	    ; test Game Reset switch
    bcs .NoStart	; reset?
    jmp Start
.NoStart:
    jmp .NextFrame
`;

// TODO: two sticks?
const TEMPLATE2 = `
;#ifdef EVENT_joyleft
    lda #%01000000	;Left?
    bit SWCHA
	bne %{.SkipMoveLeft}
    %{!joyleft}
%{.SkipMoveLeft}
;#endif
`;

const TEMPLATE3_L = `
    lda %{<xpos}
    sec
    sbc #1
    bcc %{.noclip}
    sta %{<xpos}
%{.noclip}
`;

const TEMPLATE3_R = `
    lda %{<xpos}
    clc
    adc #1
    cmp #160
    bcc %{.noclip}
    sta %{<xpos}
%{.noclip}
`;

const TEMPLATE4_S = `
    txa ; TODO
    asl
    tya
    lda %{<bitmap}   ; bitmap address
    tay
    lda bitmap_bitmapdata_b0,y
    sta %{$0},y
    lda bitmap_bitmapdata_b8,y
    sta %{$1},y
    lda colormap_colormapdata_b0,y
    sta %{$2},y
    lda colormap_colormapdata_b0,y
    sta %{$3},y
    lda sprite_height_b0,y
    sta %{$4},y
    lda ypos_ypos_b0,y
    sta %{$5},y
`

const TEMPLATE4_K = `
    ldx #192    ; lines in kernel
LVScan
    	txa		; X -> A
        sec		; set carry for subtract
        sbc %{$5}	; local coordinate
        cmp %{$4}   ; in sprite? (height)
        bcc InSprite	; yes, skip over next
        lda #0		; not in sprite, load 0
InSprite
	    tay		; local coord -> Y
        lda (%{$0}),y	; lookup color
        sta WSYNC	; sync w/ scanline
        sta GRP0	; store bitmap
        lda (%{$2}),y ; lookup color
        sta COLUP0	; store color
        dex		; decrement X
        bne LVScan	; repeat until 192 lines
`;

const SET_XPOS = `
    lda %{<xpos}
    ldy %{<plyrindex}
    jsr %{^SetHorizPos}
`

const SETHORIZPOS = `
; SetHorizPos routine
; A = X coordinate
; Y = player number (0 or 1)
SetHorizPos
	sta WSYNC	; start a new line
	sec		; set carry flag
DivideLoop
	sbc #15		; subtract 15
	bcs DivideLoop	; branch until negative
	eor #7		; calculate fine offset
	asl
	asl
	asl
	asl
	sta RESP0,y	; fix coarse position
	sta HMP0,y	; set fine offset
	rts		; return to caller
`

function test() {
    let em = new EntityManager();

    let c_kernel = em.defineComponent({name:'kernel', fields:[
        {name:'lines', dtype:'int', lo:0, hi:255}
    ]})
    let c_sprite = em.defineComponent({name:'sprite', fields:[
        {name:'height', dtype:'int', lo:0, hi:255},
        {name:'plyrindex', dtype:'int', lo:0, hi:1},
        {name:'flags', dtype:'int', lo:0, hi:255},
    ]})
    let c_player = em.defineComponent({name:'player', fields:[
        //TODO: optional?
    ]})
    let c_hasbitmap = em.defineComponent({name:'hasbitmap', fields:[
        {name:'bitmap', dtype:'ref', query:{include:['bitmap']}},
    ]})
    let c_hascolormap = em.defineComponent({name:'hascolormap', fields:[
        {name:'colormap', dtype:'ref', query:{include:['colormap']}},
    ]})
    let c_bitmap = em.defineComponent({name:'bitmap', fields:[
        {name:'bitmapdata', dtype:'array', elem:{ dtype:'int', lo:0, hi:255 }}
    ]})
    let c_colormap = em.defineComponent({name:'colormap', fields:[
        {name:'colormapdata', dtype:'array', elem:{ dtype:'int', lo:0, hi:255 }}
    ]})
    let c_xpos = em.defineComponent({name:'xpos', fields:[
        {name:'xpos', dtype:'int', lo:0, hi:255}
    ]})
    let c_ypos = em.defineComponent({name:'ypos', fields:[
        {name:'ypos', dtype:'int', lo:0, hi:255}
    ]})
    let c_xyvel = em.defineComponent({name:'xyvel', fields:[
        {name:'xvel', dtype:'int', lo:-8, hi:7},
        {name:'yvel', dtype:'int', lo:-8, hi:7}
    ]})

    // init -> [start] -> frameloop
    // frameloop -> [preframe] [kernel] [postframe]

    // TODO: where is kernel numlines?
    // temp between preframe + frame?
    // TODO: check names for identifierness
    em.defineSystem({
        name:'kernel_simple',
        tempbytes:8,
        query:{
            include:['sprite','hasbitmap','hascolormap','ypos'],
        },
        actions:[
            { text:TEMPLATE4_S, event:'preframe', iterate:'each' },
            { text:TEMPLATE4_K, event:'kernel', iterate:'once' },
        ]
    })
    em.defineSystem({
        name:'set_xpos',
        query:{
            include:['sprite','xpos']
        },
        actions:[
            { text:SET_XPOS, event:'preframe', iterate:'each' },
            //{ text:SETHORIZPOS },
        ]
    })
    // TODO: how to have subsystems? maybe need Scopes
    // TODO: easy stagger of system update?
    // TODO: easy lookup tables
    // TODO: how to init?
    // https://docs.unity3d.com/Packages/com.unity.entities@0.17/manual/ecs_systems.html
    em.defineSystem({
        name:'init',
        emits:['start'],
        query:{
            include:[], // ???
        },
        actions:[
            { text:TEMPLATE_INIT, event:'init', iterate:'once' }
        ]
    })
    em.defineSystem({
        name:'frameloop',
        emits:['preframe','kernel','postframe'],
        query:{
            include:['kernel'], // ???
        },
        actions:[
            { text:TEMPLATE1, event:'start', iterate:'once' }
        ]
    })
    em.defineSystem({
        name:'joyread',
        query:{
            include:['player']
        },
        emits:['joyup','joydown','joyleft','joyright','joybutton'],
        actions:[
            { text:TEMPLATE2, event:'postframe', iterate:'each' }
        ]
    });
    em.defineSystem({
        name:'simple_move',
        query:{
            include:['player','xpos']
        },
        actions:[
            { text:TEMPLATE3_L, event:'joyleft', iterate:'once' }, // TODO: event source?
            { text:TEMPLATE3_R, event:'joyright', iterate:'once' }, // TODO: event source?
        ]
    });
    em.defineSystem({
        name:'SetHorizPos',
        query:{ include:[] },
        actions:[
            { text:SETHORIZPOS, event:'SetHorizPos', iterate:'once' }, // TODO: event source?
        ]
    });

    let root = em.newScope("Root");
    let scene = em.newScope("Scene", root);
    let e_ekernel = root.newEntity({components:[c_kernel]});
    root.setConstValue(e_ekernel, c_kernel, 'lines', 192);

    let e_bitmap0 = root.newEntity({components:[c_bitmap]});
    // TODO: store array sizes?
    root.setConstValue(e_bitmap0, c_bitmap, 'bitmapdata', new Uint8Array([0,2,4,6,8,15,0]));

    let e_colormap0 = root.newEntity({components:[c_colormap]});
    root.setConstValue(e_colormap0, c_colormap, 'colormapdata', new Uint8Array([0,3,6,9,12,14,0]));

    let ea_playerSprite = {components:[c_sprite,c_hasbitmap,c_hascolormap,c_xpos,c_ypos,c_player]};
    let e_player0 = root.newEntity(ea_playerSprite);
    let e_player1 = root.newEntity(ea_playerSprite);

    let src = new SourceFileExport();
    root.analyzeEntities();
    root.generateCode();
    root.dump(src);
    console.log(src.toString());
}

test();
