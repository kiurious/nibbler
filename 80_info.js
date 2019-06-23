"use strict";

function NewInfoHandler() {

	let ih = Object.create(null);

	ih.table = Object.create(null);			// Map of move (e.g. "e2e4") --> info object.
	ih.version = 0;							// Incremented on any change.
	ih.nodes = 0;							// Stat sent by engine.
	ih.nps = 0;								// Stat sent by engine.

	ih.ever_received_info = false;
	ih.stderr_log = "";

	ih.one_click_moves = New2DArray(8, 8);	// Array of possible one-click moves. Updated by draw_arrows().
	ih.info_clickers = [];					// Elements in the infobox. Updated by draw_infobox().

	ih.last_highlight_dest = null;			// Used to skip redraws.
	ih.last_drawn_version = null;			// Used to skip redraws.

	ih.clear = function() {
		this.table = Object.create(null);
		this.version++;
		this.nodes = 0;
		this.nps = 0;
	};

	ih.err_receive = function(s) {
		if (s.indexOf("WARNING") !== -1 || s.indexOf("error") !== -1) {
			this.stderr_log += `<span class="red">${s}</span><br>`;
		} else {
			this.stderr_log += `${s}<br>`;
		}
	};

	ih.receive = function(s, board) {

		// Although the renderer tries to avoid sending invalid moves by
		// syncing with "isready" "readyok" an engine like Stockfish doesn't
		// behave properly, IMO. So we use the board to check legality.

		if (s.startsWith("info") && s.indexOf(" pv ") !== -1) {

			this.ever_received_info = true;
			this.version++;

			// info depth 13 seldepth 48 time 5603 nodes 67686 score cp 40 hashfull 204 nps 12080 tbhits 0 multipv 2
			// pv d2d4 g8f6 c2c4 e7e6 g2g3 f8b4 c1d2 b4e7 g1f3 e8g8 d1c2 a7a6 f1g2 b7b5 e1g1 c8b7 f1c1 b7e4 c2d1 b5c4 c1c4 a6a5 d2e1 h7h6 c4c1 d7d6

			let move = InfoVal(s, "pv");
			let move_info;

			if (this.table[move]) {						// We already have move info for this move.
				move_info = this.table[move];
			} else {									// We don't.
				if (board.illegal(move) !== "") {
					Log(`... Nibbler: invalid move received!: ${move}`);
					return;
				}
				move_info = new_info(board, move);
				this.table[move] = move_info;
			}

			let tmp;

			tmp = parseInt(InfoVal(s, "cp"), 10);		// Score in centipawns
			if (Number.isNaN(tmp) === false) {
				move_info.cp = tmp;				
			}

			tmp = parseInt(InfoVal(s, "multipv"), 10);	// Leela's ranking of the move, starting at 1
			if (Number.isNaN(tmp) === false) {
				move_info.multipv = tmp;
			}

			tmp = parseInt(InfoVal(s, "nodes"), 10);
			if (Number.isNaN(tmp) === false) {
				this.nodes = tmp;
			}

			tmp = parseInt(InfoVal(s, "nps"), 10);
			if (Number.isNaN(tmp) === false) {
				this.nps = tmp;
			}

			let new_pv = InfoPV(s);

			if (new_pv.length > 0) {
				if (CompareArrays(new_pv, move_info.pv) === false) {
					move_info.nice_pv_cache = null;
					move_info.pv = new_pv;
				}
			}

		} else if (s.startsWith("info string")) {

			this.ever_received_info = true;
			this.version++;

			// info string d2d4  (293 ) N:   12845 (+121) (P: 20.10%) (Q:  0.09001) (D:  0.000) (U: 0.02410) (Q+U:  0.11411) (V:  0.1006)

			let move = InfoVal(s, "string");

			let move_info;

			if (this.table[move]) {						// We already have move info for this move.
				move_info = this.table[move];
			} else {									// We don't.
				if (board.illegal(move) !== "") {
					Log(`... Nibbler: invalid move received!: ${move}`);
					return;
				}
				move_info = new_info(board, move);
				this.table[move] = move_info;
			}

			let tmp;

			tmp = parseInt(InfoVal(s, "N:"), 10);
			if (Number.isNaN(tmp) === false) {
				move_info.n = tmp;
			}

			tmp = parseFloat(InfoVal(s, "(D:"));
			if (Number.isNaN(tmp) === false) {
				move_info.d = tmp;
			}

			tmp = parseFloat(InfoVal(s, "(U:"));
			if (Number.isNaN(tmp) === false) {
				move_info.u = tmp;
			}

			move_info.p = InfoVal(s, "(P:");			// Worst case here is just empty string, which is OK.

			tmp = parseFloat(InfoVal(s, "(Q:"));
			if (Number.isNaN(tmp) === false) {
				move_info.q = tmp;
				move_info.value = (tmp + 1) / 2;
			}
		}
	};

	ih.sorted = function() {

		let info_list = [];

		for (let key of Object.keys(this.table)) {
			info_list.push(this.table[key]);
		}

		info_list.sort((a, b) => {

			// multipv ranking - lower is better...

			if (a.multipv < b.multipv) {
				return -1;
			}
			if (a.multipv > b.multipv) {
				return 1;
			}

			// node count - higher is better...

			if (a.n < b.n) {
				return 1;
			}
			if (a.n > b.n) {
				return -1;
			}

			// centipawn score - higher is better...

			if (a.cp < b.cp) {
				return 1;
			}
			if (a.cp > b.cp) {
				return -1;
			}

			return 0;
		});

		return info_list;
	};

	ih.must_draw_infobox = function() {
		this.last_drawn_version = null;
	};

	ih.draw_infobox = function(mouse_point, active_square, leela_should_go, active_colour) {

		if (!this.ever_received_info) {
			if (this.stderr_log.length > 0) {
				infobox.innerHTML += this.stderr_log;
				this.stderr_log = "";
			}
			return;
		}

		// By default we're highlighting nothing...
		let highlight_dest = null;
		let one_click_move = "__none__";

		// But if the hovered square actually has a one-click move available, highlight its variation,
		// unless we have an active (i.e. clicked) square...
		if (mouse_point && this.one_click_moves[mouse_point.x][mouse_point.y] && !active_square) {
			highlight_dest = mouse_point;
			one_click_move = this.one_click_moves[mouse_point.x][mouse_point.y];
		}

		// Maybe we can skip drawing the infobox, and just return...

		if (this.last_drawn_version === this.version) {
			if (this.last_highlight_dest === highlight_dest) {
				return;
			}
		}

		this.last_highlight_dest = highlight_dest;
		this.last_drawn_version = this.version;

		// OK I guess we're drawing...

		let info_list = this.sorted();
		let elements = [];									// Not HTML elements, just our own objects.

		if (leela_should_go === false) {
			elements.push({
				class: "yellow",
				text: config.versus === "" ? "HALTED " : "YOUR MOVE ",
			});
		}

		elements.push({
			class: "gray",
			text: `Nodes: ${this.nodes}, N/s: ${this.nps}<br><br>`
		});

		for (let i = 0; i < info_list.length && i < config.max_info_lines; i++) {

			let new_elements = [];

			let info = info_list[i];

			let value_string = "?";
			if (config.show_cp) {
				value_string = info.cp.toString();
				if (info.cp > 0) {
					value_string = "+" + value_string;
				}
			} else {
				value_string = info.value_string(1);
			}

			new_elements.push({
				class: "blue",
				text: value_string + " ",
			});

			let colour = active_colour;

			let nice_pv = info.nice_pv();

			for (let n = 0; n < nice_pv.length; n++) {
				let nice_move = nice_pv[n];
				let element = {
					class: colour === "w" ? "white" : "pink",
					text: nice_move + " ",
					move: info.pv[n],
				};
				if (nice_move.includes("O-O")) {
					element.class += " nobr";
				}
				new_elements.push(element);
				colour = OppositeColour(colour);
			}

			let extra_stat_strings = [];

			if (config.show_n) {
				let divisor = this.nodes > 0 ? this.nodes : 1;
				let node_display_fraction = (100 * info.n / divisor).toFixed(2);
				extra_stat_strings.push(`N: ${node_display_fraction}%`);
			}

			if (config.show_p) {
				extra_stat_strings.push(`P: ${info.p}`);
			}

			if (config.show_u) {
				extra_stat_strings.push(`U: ${info.u.toFixed(3)}`);
			}

			if (extra_stat_strings.length > 0) {
				new_elements.push({
					class: "gray",
					text: "(" + extra_stat_strings.join(", ") + ")"
				});
			}

			if (info.move === one_click_move) {
				for (let e of new_elements) {
					e.class += " redback";
				}
			}

			if (new_elements.length > 0) {					// Always true.
				new_elements[new_elements.length - 1].text += "<br><br>";
			}

			elements = elements.concat(new_elements);
		}

		// Generate the new innerHTML for the infobox <div>

		let new_inner_parts = [];

		for (let n = 0; n < elements.length; n++) {
			let part = `<span id="infobox_${n}" class="${elements[n].class}">${elements[n].text}</span>`;
			new_inner_parts.push(part);
		}

		infobox.innerHTML = new_inner_parts.join("");		// Setting innerHTML is performant. Direct DOM manipulation is worse, somehow.

		// And save our elements so that we know what clicks mean.

		this.info_clickers = elements;						// We actually only need the move or its absence in each object. Meh.
	};

	ih.moves_from_click = function(event) {

		let n;

		for (let item of event.path) {
			if (typeof item.id === "string" && item.id.startsWith("infobox_")) {
				n = parseInt(item.id.slice(8), 10);
				break;
			}
		}

		if (n === undefined) {
			return [];
		}

		// This is a bit icky, it relies on the fact that our clickers list
		// has some objects that lack a move property (the blue info bits).

		if (!this.info_clickers || n < 0 || n >= this.info_clickers.length) {
			return [];
		}

		let move_list = [];

		// Work backwards until we get to the start of the line...

		for (; n >= 0; n--) {
			let element = this.info_clickers[n];
			if (!element || !element.move) {
				break;
			}
			move_list.push(element.move);
		}

		move_list.reverse();

		return move_list;
	};

	ih.draw_arrows = function() {

		context.lineWidth = 8;
		context.textAlign = "center";
		context.textBaseline = "middle";
		context.font = config.board_font;

		let arrows = [];
		let heads = [];

		for (let x = 0; x < 8; x++) {
			for (let y = 0; y < 8; y++) {
				this.one_click_moves[x][y] = null;
			}
		}

		let info_list = this.sorted();

		if (info_list.length > 0) {
			
			for (let i = 0; i < info_list.length; i++) {

				if (info_list[i].u < config.uncertainty_cutoff || i === 0) {

					let [x1, y1] = XY(info_list[i].move.slice(0, 2));
					let [x2, y2] = XY(info_list[i].move.slice(2, 4));

					let loss = 0;

					if (typeof info_list[0].value === "number" && typeof info_list[i].value === "number") {
						loss = info_list[0].value - info_list[i].value;
					}

					let colour;

					if (i === 0) {
						colour = config.best_colour;
					} else if (loss > config.terrible_move_threshold) {
						colour = config.terrible_colour;
					} else if (loss > config.bad_move_threshold) {
						colour = config.bad_colour;
					} else {
						colour = config.good_colour;
					}

					arrows.push({
						colour: colour,
						x1: x1,
						y1: y1,
						x2: x2,
						y2: y2,
						info: info_list[i]
					});

					if (!this.one_click_moves[x2][y2]) {
						this.one_click_moves[x2][y2] = info_list[i].move;
						heads.push({
							colour: colour,
							x2: x2,
							y2: y2,
							info: info_list[i]
						});
					}
				}
			}
		}

		// It looks best if the longest arrows are drawn underneath. Manhattan distance is good enough.
		// For the sake of displaying the best pawn promotion (of the 4 possible), sort ties are broken
		// by winrate, with lower winrates drawn first.

		arrows.sort((a, b) => {
			if (Math.abs(a.x2 - a.x1) + Math.abs(a.y2 - a.y1) < Math.abs(b.x2 - b.x1) + Math.abs(b.y2 - b.y1)) {
				return 1;
			}
			if (Math.abs(a.x2 - a.x1) + Math.abs(a.y2 - a.y1) > Math.abs(b.x2 - b.x1) + Math.abs(b.y2 - b.y1)) {
				return -1;
			}
			if (a.info.n < b.info.n) {
				return -1;
			}
			if (a.info.n > b.info.n) {
				return 1;
			}
			return 0;
		});

		for (let o of arrows) {
			let cc1 = CanvasCoords(o.x1, o.y1);
			let cc2 = CanvasCoords(o.x2, o.y2);
			context.strokeStyle = o.colour;
			context.fillStyle = o.colour;
			context.beginPath();
			context.moveTo(cc1.cx, cc1.cy);
			context.lineTo(cc2.cx, cc2.cy);
			context.stroke();
		}

		for (let o of heads) {
			let cc2 = CanvasCoords(o.x2, o.y2);
			context.fillStyle = o.colour;
			context.beginPath();
			context.arc(cc2.cx, cc2.cy, 12, 0, 2 * Math.PI);
			context.fill();
			context.fillStyle = "black";

			let s = "?";

			switch (config.arrowhead_type) {
			case 0:
				s = o.info.value_string(0);
				break;
			case 1:
				let divisor = this.nodes > 0 ? this.nodes : 1;
				s = (100 * o.info.n / divisor).toFixed(0);
				break;
			case 2:
				let pstr = o.info.p;
				if (pstr.endsWith("%")) {
					pstr = pstr.slice(0, pstr.length - 1);
				}
				let p = parseFloat(pstr);
				if (Number.isNaN(p) === false) {
					s = p.toFixed(0);
				}
				break;
			case 3:
				s = o.info.multipv;
				break;
			default:
				s = "!";
				break;
			}

			context.fillText(s, cc2.cx, cc2.cy + 1);
		}
	};

	return ih;
}

// --------------------------------------------------------------------------------------------

let info_prototype = {

	nice_pv: function() {

		// Human readable moves. Since there's no real guarantee that our
		// moves list is legal, we legality check them. We at least know
		// the initial move is legal, since it's checked on receipt.

		if (this.nice_pv_cache) {
			return Array.from(this.nice_pv_cache);
		}

		let tmp_board = this.board;

		if (!this.pv || this.pv.length === 0) {
			return [tmp_board.nice_string(this.move)];
		}

		let ret = [];

		for (let move of this.pv) {
			if (tmp_board.illegal(move) !== "") {
				break;
			}
			ret.push(tmp_board.nice_string(move));
			tmp_board = tmp_board.move(move);
		}

		this.nice_pv_cache = ret;
		return Array.from(this.nice_pv_cache);
	},

	value_string: function(dp) {
		if (typeof this.value !== "number") {
			return "?";
		}
		let pc = Math.floor(this.value * 100 * 10) / 10;
		if (pc < 0) {
			return "?";				// Happens when 0 nodes, I think.
		}
		return pc.toFixed(dp);
	}
};

function new_info(board, move) {
	let info = Object.create(info_prototype);
	info.board = board;
	info.cp = -99999;
	info.d = 0;				// Although wrong, this is the value Leela sends if WDL not supported.
	info.move = move;
	info.multipv = 999;
	info.n = 0;
	info.p = "?";			// Note we receive P as a string, unlike the other stuff.
	info.pv = [];
	info.nice_pv_cache = null;
	info.q = -1;
	info.u = 2;				// Is this a sane default? Values above 1 are possible, so...
	info.value = 0;
	return info;
}