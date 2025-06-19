import uWS from 'uWebSockets.js';
import fs from 'fs';
import '../shared/constants.js';
import badWords from './badwords.js';
import { closest } from 'color-2-name';

import { networkInterfaces } from 'os';

const captchaSecretKey = "[captcha key]"

function serverIp(){
    const nets = networkInterfaces();
    const results = {};
    
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            // Skip over non-IPv4 and internal (i.e. 127.0.0.1) addresses
            // 'IPv4' is in Node <= 17, from 18 it's a number 4 or 6
            const familyV4Value = typeof net.family === 'string' ? 'IPv4' : 4
            if (net.family === familyV4Value && !net.internal) {
                if (!results[name]) {
                    results[name] = [];
                }
                results[name].push(net.address);
            }
        }
    }

    return results;
}

const info = serverIp();

const isProd = !(Array.isArray(info['Wi-Fi']) && info['Wi-Fi'][0] === 'your local developer ip address');
console.log({isProd});

let leaderboard = {/*teamId: kills*/};
function sendLeaderboard(){
    let leaderboardData = [];
    let bufLen = 1;
    for(let key in leaderboard){
        const name = teamToName(key);
        leaderboardData.push({
            id: key,
            kills: leaderboard[key],
            name: name,
            nameLen: name.length
        })
        let add = name.length;
        if(add % 2 === 1) add++;
        bufLen += add + 6// 2 bytes for id, kills, and the name length
    }
    if(bufLen % 2 === 1) bufLen++;
    let buf = new Uint8Array(bufLen);
    let u16 = new Uint16Array(buf.buffer);
    u16[0] = 48027;

    let i = 1;
    for(let j = 0; j < leaderboardData.length; j++){
        const d = leaderboardData[j];
        u16[i++] = d.id;
        u16[i++] = d.kills;
        u16[i++] = d.nameLen;

        encodeAtPosition(d.name, buf, (i) * 2);

        i += Math.ceil(d.nameLen / 2);
    }

    return buf;
}

// seeded rng
function teamToColor(team){
    let num = Math.round((Math.sin(team * 10000) + 1) / 2 * 0xFFFFFF);

    let r = (num & 0xFF0000) >>> 16;
    let g = (num & 0x00FF00) >>> 8;
    let b = (num & 0x0000FF);

    if(r + g + b > 520){
        r /= 2;
        g /= 2;
        b /= 2;
    }

    return {r, g, b};
}

function teamToName(team){
    const color = teamToColor(team);

    return closest(`rgb(${color.r}, ${color.g}, ${color.b})`).name;
}

global.board = [];
global.teams = [];// ids of pieces occupying which cell
for(let i = 0; i < boardW; i++){
    board[i] = [];
    teams[i] = [];
    for(let j = 0; j < boardH; j++){
        board[i][j] = 0;
        teams[i][j] = 0;
    }
}

function setSquare(x,y,piece,team){
    board[x][y] = piece;
    teams[x][y] = team;

    // x, y, piece, team
    const buf = new Uint16Array(4);
    buf[0] = x;
    buf[1] = y;
    buf[2] = piece;
    buf[3] = team;
    broadcast(buf);
}

function move(startX, startY, finX, finY){
    const lastPiece = board[finX][finY];
    const lastTeam = teams[finX][finY];

    board[finX][finY] = board[startX][startY];
    teams[finX][finY] = teams[startX][startY];

    board[startX][startY] = 0;
    teams[startX][startY] = 0;

    // startX, startY, finX, finY, another byte to differentiate
    const buf = new Uint16Array(5);
    buf[0] = startX;
    buf[1] = startY;
    buf[2] = finX;
    buf[3] = finY;
    broadcast(buf);

    if(lastPiece !== 0 && lastTeam === 0){
        // add piece to your collection!
        setSquare(startX, startY, lastPiece, teams[finX][finY]);
    }

    if(lastPiece === 6 && lastTeam !== 0 && clients[lastTeam] !== undefined){
        // le king is dead
        clients[lastTeam].dead = true;
        clients[lastTeam].respawnTime = Date.now() + global.respawnTime - 500;
        teamsToNeutralize.push(lastTeam);

        // add kill
        leaderboard[teams[finX][finY]]++;
        leaderboard[lastTeam] = 0; // reset kills
        broadcast(sendLeaderboard());
    }
}

// read saved
// const colorToNumber = {};
// for(let i = 0; i < global.colors.length; i++){
//     colorToNumber[colors[i]] = i;
// }

// const dataPath = 'server/thumbnailData.thumbnail';
// if (fs.existsSync(dataPath)) {
//     const buf = fs.readFileSync(dataPath);

//     let ind = 0;
//     for(let i = 0; i < thumbnailW; i++){
//         for(let j = 0; j < thumbnailH; j++){
//             thumbnail[i][j] = buf[ind++];
//         }
//     }
// }

function componentToHex(c) {
    var hex = c.toString(16);
    return hex.length == 1 ? "0" + hex : hex;
}

function rgbToHex(r, g, b) {
    return "#" + componentToHex(r) + componentToHex(g) + componentToHex(b);
}

const PORT = 3000;

global.clients = {};

let connectedIps = {};

let id = 1;
function generateId(){
    if(id >= 65532) id = 0;
    return id++;
}

const decoder = new TextDecoder();
function decodeText(u8array, startPos=0, endPos=Infinity){
	return decoder.decode(u8array).slice(startPos, endPos);
}

// let needsVerification = [];
// setInterval(() => {
//     const now = Date.now();
//     for(let i = 0; i < needsVerification.length; i++){
//         const ws = needsVerification[i];
//         const dt = now - ws.timeCreated;
//         if(ws.verified === false && dt > 60 * 1000 && ws.closed === false){
//             ws.close();
//         }
//     }
//     needsVerification.length = 0;
// }, 1000 * 60)

let filledSquares = 0;
setInterval(() => {
    filledSquares = 0;
    for(let i = 0; i < boardW; i++){
        for(let j = 0; j < boardH; j++){
            if(board[i][j] !== 0) filledSquares++;
        }
    }

    if(teamsToNeutralize.length === 0) return;

    // tell the clients to do the same
    const buf = new Uint16Array(2 + teamsToNeutralize.length);
    buf[0] = 64535;
    buf[1] = 12345;
    for(let i = 0; i < teamsToNeutralize.length; i++){
        buf[i+2] = teamsToNeutralize[i];
    }
    broadcast(buf);
    
    for(let i = 0; i < boardW; i++){
        for(let j = 0; j < boardH; j++){
            if(teamsToNeutralize.includes(teams[i][j]) === true){
                // delete kings, neutralize other pieces
                if(board[i][j] === 6){
                    board[i][j] = 0;
                }
                teams[i][j] = 0;
            }
        }
    }

    teamsToNeutralize.length = 0;
}, 440)

setInterval(() => {
    const filledRatio = filledSquares / (boardW * boardH);
    if(Math.random() * 0.34 < filledRatio) return;

    // spawn a random piece
    let randomX, randomY, succeeded = false;
    for(let tries = 0; tries < 10; tries++){
        randomX = Math.floor(Math.random() * boardW);
        randomY = Math.floor(Math.random() * boardH);

        if(board[randomX][randomY] !== 0){
            continue;
        }
        succeeded = true;
        break;
    }

    if(succeeded === true){
        // spawn piece
        let piece = 1 + Math.floor(Math.random() * 4);
        if(Math.random() < 0.045) piece = 5;
        setSquare(randomX, randomY, piece/*random number between 1 and 5*/, 0);
    }
}, 300)

let teamsToNeutralize = [];

let usedCaptchaKeys = {};
setInterval(() => {
    const now = Date.now();
    for(let key in usedCaptchaKeys){
        const date = usedCaptchaKeys[key];
        if(now - date > 2 * 60 * 1000){
            // default captcha token expires after 2 mins
            delete usedCaptchaKeys[key];
        }
    }  
}, 2 * 60 * 1000)

global.app = uWS.App().ws('/*', {
    compression: 0,
    maxPayloadLength: 4096,
    idleTimeout: 0,
    open: (ws) => {
        // send image
        ws.id = generateId();
        clients[ws.id] = ws;

        ws.verified = false;
        ws.dead = false;
        ws.respawnTime = 0;

        ws.lastMovedTime = 0;

        ws.chatMsgsLast5s = 0;
        ws.lastChat5sTime = 0;

        // ws.name = teamToName(ws.id);

        // send initial board state
        ws.subscribe('global');

        const buf = new Uint16Array(boardW * boardH * 2 + 1);
        buf[0] = ws.id;
        let ind = 1;
        for(let i = 0; i < boardW; i++){
            for(let j = 0; j < boardH; j++){
                buf[ind++] = board[i][j];
            }
        }
        for(let i = 0; i < boardW; i++){
            for(let j = 0; j < boardH; j++){
                buf[ind++] = teams[i][j];
            }
        }
        send(ws, buf);

        leaderboard[ws.id] = 0;
        broadcast(sendLeaderboard());
    },
    message: (ws, data) => {
        // there's only two messages - move piece from one square to another or join game
        const u8 = new Uint8Array(data);
        if(ws.verified === false || (ws.dead === true && !(u8[0] === 0xf7 && u8[1] === 0xb7/*chat msgs are ok*/) )){
            (async()=>{
                if(ws.verified === false){
                    // captcha
                    const captchaKey = decodeText(u8);
                    if(usedCaptchaKeys[captchaKey] !== undefined){
                        if(ws.closed !== true) ws.close();
                        return;
                    }
    
                    await new Promise((resolve) => {
                        fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
                            method: 'POST',
                            headers: { "Content-Type": "application/x-www-form-urlencoded" },
                            body: `secret=${captchaSecretKey}&response=${captchaKey}`,
                        }).then(async (d) => {
                            const response = JSON.parse(await d.text());
                            
                            if(response.success === true){
                                ws.verified = true;
                            } else {
                                if(ws.closed !== true) ws.close();
                            }
        
                            usedCaptchaKeys[captchaKey] = Date.now();
                            resolve();
                        })
                    })
                    ws.verified = true;
                }
    
                if(Date.now() < ws.respawnTime){
                    return;
                }
    
                // find a place for the king
                let randomX, randomY;
                outer: for(let tries = 0; tries < 100; tries++){
                    randomX = Math.floor(Math.random() * boardW);
                    randomY = Math.floor(Math.random() * boardH);
    
                    if(board[randomX][randomY] !== 0){
                        continue outer;
                    }

                    for(let x = randomX-3; x <= randomX+3; x++){
                        inner: for(let y = randomY-3; y <= randomY+3; y++){
                            if(board[x] === undefined || board[x][y] === undefined) continue inner;

                            if(board[x][y] === 6){
                                continue outer;
                            }
                        }
                    }

                    break outer;
                }
    
                // whether we found an empty square or not, place the king
                setSquare(randomX, randomY, 6, ws.id);
    
                ws.verified = true;
                ws.dead = false;
            })();

            return;
        }

        if(data.byteLength % 2 !== 0) return;

        const decoded = new Uint16Array(data);

        if(decoded[0] === 47095){
            if(data.byteLength > 1000) return;

            const now = Date.now();
            if(now - ws.lastChat5sTime > 10000){
                ws.chatMsgsLast5s = 0;
                ws.lastChat5sTime = now;
            }

            ws.chatMsgsLast5s++;
            if(ws.chatMsgsLast5s > 3){
                let chatMessage = '[Server] Spam detected. You cannot send messages for up to 10s.';
                if(chatMessage.length % 2 === 1){
                    chatMessage += ' ';
                }
                const buf = new Uint8Array(chatMessage.length + 4);
                const u16 = new Uint16Array(buf.buffer);
                buf[0] = 247;
                buf[1] = 183;
                u16[1] = 65534;
                encodeAtPosition(chatMessage, buf, 4);
                send(ws, buf);
                return;
            }

            const txt = decodeText(data, 2);
            if(txt.length > 64){
                return;
            }

            let chatMessage = /*ws.name + ': ' +*/ txt;
            let id = ws.id;

            if(isBadWord(chatMessage) === true){
                return;
            }

            if(chatMessage.slice(0,7) === '/announce'/*this will not work on chess.ytdraws*/){
                chatMessage = '[SERVER] ' + chatMessage.slice(8);
                id = 65534;
            }

            if(chatMessage.length % 2 === 1){
                chatMessage += ' ';
            }

            const buf = new Uint8Array(chatMessage.length + 4);
            const u16 = new Uint16Array(buf.buffer);
            buf[0] = 247;
            buf[1] = 183;
            u16[1] = id;
            encodeAtPosition(chatMessage, buf, 4);
            broadcast(buf);
        }

        // move piece - x,y to x,y
        else if(data.byteLength === 8){
            const now = Date.now();
            if(now - ws.lastMovedTime < moveCooldown - 500){
                return;
            }

            const startX = decoded[0];
            const startY = decoded[1];

            const finX = decoded[2];
            const finY = decoded[3];

            if(startX >= boardW || startY >= boardH || finX >= boardW || finY >= boardH){
                return;
            }

            if(board[startX][startY] === undefined || teams[startX][startY] !== ws.id){
                return;
            }

            // check if it's legal
            const legalMoves = generateLegalMoves(startX, startY, board, teams);

            let includes = false;
            for(let i = 0; i < legalMoves.length; i++){
                if(legalMoves[i][0] === finX && legalMoves[i][1] === finY){
                    includes = true;
                    break;
                }
            }
            if(includes === false) return;

            move(startX, startY, finX, finY);

            ws.lastMovedTime = now;

            return;
        }
    },
    close: (ws) => {
        delete clients[ws.id];

        ws.closed = true;

        teamsToNeutralize.push(ws.id);

        // if player existed in leaderboard send
        if(delete leaderboard[ws.id]) {
            broadcast(sendLeaderboard());
        }

        if(ws.ip){
            delete connectedIps[ws.ip];
        }
    },
    upgrade: (res, req, context) => {
        let ip = getIp(res, req);

        if(ip !== undefined){
            if(connectedIps[ip] === true){
                res.end("Connection rejected");
                console.log('ws ratelimit', ip);
                return;
            }
            connectedIps[ip] = true;
        }
    
        res.upgrade(
            { ip },  // Attach IP to the WebSocket object
            req.getHeader('sec-websocket-key'),
            req.getHeader('sec-websocket-protocol'),
            req.getHeader('sec-websocket-extensions'),
            context
        );
    },
}).listen(PORT, (token) => {
    if (token) {
        console.log('Server Listening to Port ' + PORT);
    } else {
        console.log('Failed to Listen to Child Server ' + PORT);
    }
}, );

function getIp(res, req) {
    // Try to get the real client IP from proxy headers
    let forwardedIp = req.getHeader('cf-connecting-ip') ||  // Cloudflare
        req.getHeader('x-forwarded-for') || 
        req.getHeader('x-real-ip');
    if (forwardedIp) {
      return forwardedIp.split(',')[0].trim(); // Handle multiple IPs in X-Forwarded-For
    }
  
    // Fallback: Get the direct remote address
    let rawIp = new TextDecoder().decode(res.getRemoteAddressAsText());
  
    // Convert IPv6-mapped IPv4 (e.g., ::ffff:192.168.1.1) to IPv4
    if (rawIp.startsWith('::ffff:')) {
      return rawIp.substring(7);
    }
  
    return rawIp;
}

global.send = (ws, msg) => {
    ws.send(msg, true, false);
}

global.broadcast = (msg) => {
    app.publish('global', msg, true, false);
}

let servedIps = {};
setInterval(() => {
    servedIps = {};
    fileServedIps = {};
}, 20 * 1000)
app.get("/", (res, req) => {
    const ip = getIp(res, req);
    if(servedIps[ip] === undefined) servedIps[ip] = 0;
    
    if(servedIps[ip] > 3 && isProd === true) {
        res.end('ratelimit. Try again in 20 seconds.');
        console.log('main site ratelimit from', ip);
        return;
    }
    servedIps[ip]++;

    console.log('serving index');
    res.end(fs.readFileSync('client/index.html'));
});

let fileServedIps = {};
app.get("/:filename/:filename2", (res, req) => {
    const ip = getIp(res, req);
    if(fileServedIps[ip] === undefined) fileServedIps[ip] = 0;
    fileServedIps[ip]++;
    if(fileServedIps[ip] > 25 && isProd === true){
        res.end('ratelimit. try again in 20 seconds.');
        console.log('file ratelimit', ip);
        return;
    }

    if(req.getParameter(0) === 'server') {res.cork(()=>{res.end();});return;}
    let path = req.getParameter(0) + '/' + req.getParameter(1);
    if (fs.existsSync(path) && fs.statSync(path).isFile()) {
        const pathEnd = path.slice(path.length-3);
        if(pathEnd === 'css') res.writeHeader("Content-Type", "text/css");
        else res.writeHeader("Content-Type", "text/javascript");
        const file = fs.readFileSync(path);

        res.end(file);
    } else {
        res.cork(() => {
            res.writeStatus('404 Not Found');
            res.end();
        })
    }
});

app.get("/client/assets/:filename", (res, req) => {
    const ip = getIp(res, req);
    if(fileServedIps[ip] === undefined) fileServedIps[ip] = 0;
    fileServedIps[ip]++;
    if(fileServedIps[ip] > 25 && isProd === true){
        res.end('ratelimit. try again in 20 seconds.');
        console.log('asset file ratelimit', ip);
        return;
    }

    let path = 'client/assets/' + req.getParameter(0);
    if (fs.existsSync(path) && fs.statSync(path).isFile()) {
        const pathEnd = path.slice(path.length-3);
        if(pathEnd === 'png') res.writeHeader("Content-Type", "image/png");
        else res.writeHeader("Content-Type", "audio/mpeg");
        const file = fs.readFileSync(path);

        res.end(file);
    } else {
        res.cork(() => {
            res.writeStatus('404 Not Found');
            res.end();
        })
    }
});

const alphabet = 'abcdefghijklmnopqrstuvwxyz';

const alphabetMap = {};
for(let i = 0; i < alphabet.length; i++){
    alphabetMap[alphabet[i]] = true;
}

function isBadWord(str){
    let filtered = '';
    for(let i = 0; i < str.length; i++){
        const char = str[i].toLowerCase();
        if(alphabetMap[char]){
            filtered += char;
        }
    }

    for(let i = 0; i < badWords.length; i++){
        if(filtered.includes(badWords[i])){
            console.log('bad word', badWords[i], filtered);
            return true;
        }
    }

    return false;
}

const encoder = new TextEncoder();
function encodeAtPosition(string, u8array, position) {
	return encoder.encodeInto(
		string,
		position ? u8array.subarray(position | 0) : u8array,
	);
}
