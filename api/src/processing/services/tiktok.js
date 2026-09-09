import { createHash } from "node:crypto";

import Cookie from "../cookie/cookie.js";

import { extract, normalizeURL } from "../url.js";
import { genericUserAgent } from "../../config.js";
import { updateCookie } from "../cookie/manager.js";
import { createStream } from "../../stream/manage.js";
import { convertLanguageCode } from "../../misc/language-codes.js";

const shortDomain = "https://vt.tiktok.com/";

// tiktok's edge serves a "please wait" page with a SHA256 proof-of-work
// challenge to requests it doesn't recognize (datacenter IPs, new clients).
// a real browser solves this in JS in ~50ms; we solve it the same way so
// the actual SSR page (with __UNIVERSAL_DATA_FOR_REHYDRATION__) comes back.
// same technique yt-dlp uses (TikTokBaseIE._solve_challenge_and_set_cookies).
function solveWafChallenge(html) {
    const csMatch = html.match(/<p id="cs" class="([^"]+)"/);
    if (!csMatch) return null;

    const padded = csMatch[1] + "=".repeat((4 - (csMatch[1].length % 4)) % 4);
    const data = JSON.parse(Buffer.from(padded, "base64").toString());

    const seed = Buffer.from(data.v.a, "base64");
    const target = Buffer.from(data.v.c, "base64").toString("hex");

    let solution;
    for (let i = 0; i <= 1_000_000; i++) {
        const digest = createHash("sha256").update(seed).update(String(i)).digest("hex");
        if (digest === target) {
            solution = i;
            break;
        }
    }
    if (solution === undefined) return null;

    data.d = Buffer.from(String(solution)).toString("base64");

    const wciMatch = html.match(/<p id="wci" class="([^"]*)"/);
    const pairs = [[
        wciMatch?.[1] || "_wafchallengeid",
        Buffer.from(JSON.stringify(data)).toString("base64"),
    ]];

    const rciMatch = html.match(/<p id="rci" class="([^"]+)"/);
    const rsMatch = html.match(/<p id="rs" class="([^"]+)"/);
    if (rciMatch && rsMatch) pairs.push([rciMatch[1], rsMatch[1]]);

    return pairs;
}

async function fetchWithWafBypass(url, headers) {
    let res = await fetch(url, { headers });
    let html = await res.text();

    if (!html.includes("__UNIVERSAL_DATA_FOR_REHYDRATION__")) {
        const pairs = solveWafChallenge(html);
        if (pairs) {
            const cookie = pairs.map(([k, v]) => `${k}=${v}`).join('; ');
            const retryHeaders = {
                ...headers,
                cookie: headers.cookie ? `${headers.cookie}; ${cookie}` : cookie,
            };
            res = await fetch(url, { headers: retryHeaders });
            html = await res.text();
        }
    }

    return { res, html };
}

export default async function(obj) {
    const cookie = new Cookie({});
    let postId = obj.postId;

    if (!postId) {
        let html = await fetch(`${shortDomain}${obj.shortLink}`, {
            redirect: "manual",
            headers: {
                "user-agent": genericUserAgent.split(' Chrome/1')[0]
            }
        }).then(r => r.text()).catch(() => {});

        if (!html) return { error: "fetch.fail" };

        if (html.startsWith('<a href="https://')) {
            const extractedURL = html.split('<a href="')[1].split('?')[0];
            const { host, patternMatch } = extract(normalizeURL(extractedURL));
            if (host === "tiktok") {
                postId = patternMatch?.postId;
            }
        }
    }
    if (!postId) return { error: "fetch.short_link" };

    // should always be /video/, even for photos
    const { res, html } = await fetchWithWafBypass(`https://www.tiktok.com/@i/video/${postId}`, {
        "user-agent": genericUserAgent,
        cookie,
    });
    updateCookie(cookie, res.headers);

    let detail;
    try {
        const json = html
            .split('<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">')[1]
            .split('</script>')[0];

        const data = JSON.parse(json);
        const videoDetail = data["__DEFAULT_SCOPE__"]["webapp.video-detail"];

        if (!videoDetail) throw "no video detail found";

        // status_deleted or etc
        if (videoDetail.statusMsg) {
            return { error: "content.post.unavailable"};
        }

        detail = videoDetail?.itemInfo?.itemStruct;
    } catch {
        return { error: "fetch.fail" };
    }

    if (detail.isContentClassified) {
        return { error: "content.post.age" };
    }

    if (!detail.author) {
        return { error: "fetch.empty" };
    }

    let video, videoFilename, audioFilename, audio, images,
        filenameBase = `tiktok_${detail.author?.uniqueId}_${postId}`,
        bestAudio; // will get defaulted to m4a later on in match-action

    images = detail.imagePost?.images;

    let playAddr = detail.video?.playAddr;

    if (obj.h265) {
        const h265PlayAddr = detail?.video?.bitrateInfo?.find(b => b.CodecType.includes("h265"))?.PlayAddr.UrlList[0]
        playAddr = h265PlayAddr || playAddr
    }

    if (!obj.isAudioOnly && !images) {
        video = playAddr;
        videoFilename = `${filenameBase}.mp4`;
    } else {
        audio = playAddr;
        audioFilename = `${filenameBase}_audio`;

        if (obj.fullAudio || !audio) {
            audio = detail.music.playUrl;
            audioFilename += `_original`
        }
        if (audio.includes("mime_type=audio_mpeg")) bestAudio = 'mp3';
    }

    if (video) {
        let subtitles, fileMetadata;
        if (obj.subtitleLang && detail?.video?.subtitleInfos?.length) {
            const langCode = convertLanguageCode(obj.subtitleLang);
            const subtitle = detail?.video?.subtitleInfos.find(
                s => s.LanguageCodeName.startsWith(langCode) && s.Format === "webvtt"
            )
            if (subtitle) {
                subtitles = subtitle.Url;
                fileMetadata = {
                    sublanguage: langCode,
                }
            }
        }
        return {
            urls: video,
            subtitles,
            fileMetadata,
            filename: videoFilename,
            headers: { cookie }
        }
    }

    if (images && obj.isAudioOnly) {
        return {
            urls: audio,
            audioFilename: audioFilename,
            isAudioOnly: true,
            bestAudio,
            headers: { cookie }
        }
    }

    if (images) {
        let imageLinks = images
            .map(i => i.imageURL.urlList.find(p => p.includes(".jpeg?")))
            .map((url, i) => {
                if (obj.alwaysProxy) url = createStream({
                    service: "tiktok",
                    type: "proxy",
                    url,
                    filename: `${filenameBase}_photo_${i + 1}.jpg`
                })

                return {
                    type: "photo",
                    url
                }
            });

        return {
            picker: imageLinks,
            urls: audio,
            audioFilename: audioFilename,
            isAudioOnly: true,
            bestAudio,
            headers: { cookie }
        }
    }

    if (audio) {
        return {
            urls: audio,
            audioFilename: audioFilename,
            isAudioOnly: true,
            bestAudio,
            headers: { cookie }
        }
    }

    return { error: "fetch.empty" };
}
