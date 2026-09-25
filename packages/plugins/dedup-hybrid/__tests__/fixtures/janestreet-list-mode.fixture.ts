/**
 * Spec 1724 regression fixture — one list-mode crawl of the Jane Street board
 * (Greenhouse, `siteType: ["janestreet"]`, `resultsWanted: 30`, `dedup=false`),
 * captured from the API's NDJSON stream on 2026-09-25.
 *
 * Titles, companies, locations, employment types, ids and URLs are as served.
 * Descriptions are ENCODED, not quoted: each shingle token (lower-case
 * `[a-z0-9]+`, exactly as `tokenizeForShingles` splits) is replaced by
 * its index, in base 36, in order of first appearance across this file. The
 * mapping is one-to-one per token, so identical
 * texts stay identical and every pair keeps its exact shingle-set Jaccard
 * similarity — which is all the MinHash stage reads — without reproducing the
 * employer's prose. Before the merge gate the default engine folded these 30
 * postings into 20 records.
 */
export interface JaneStreetFixtureRow {
  id: string;
  site: string;
  title: string;
  companyName: string;
  jobUrl: string;
  location: { city?: string; state?: string; country?: string; text?: string } | null;
  locations: { city?: string; state?: string; country?: string; text?: string }[];
  isRemote: boolean;
  employmentType: string;
  datePosted: string;
  department?: string;
  atsType?: string;
  description: string;
}

export const JANE_STREET_LIST_MODE_ROWS: JaneStreetFixtureRow[] = [
  {
    "id": "janestreet-8836991002",
    "site": "janestreet",
    "title": "Architect ",
    "companyName": "Jane Street",
    "jobUrl": "https://www.janestreet.com/join-jane-street/apply/8836991002?gh_jid=8836991002",
    "location": {
      "city": "New York",
      "state": "NY",
      "country": "United States",
      "text": "New York, New York, United States"
    },
    "locations": [
      {
        "city": "New York",
        "state": "NY",
        "country": "United States",
        "text": "New York, New York, United States"
      }
    ],
    "isRemote": false,
    "employmentType": "Full-Time: Experienced",
    "datePosted": "2026-09-24",
    "department": "Real Estate Engineering",
    "atsType": "greenhouse",
    "description": "0 1 2 3 4 5 6 7 8 9 a b c d e f g h i j k g l m n o p q r s t u v 9 c w x y z 10 11 12 o 13 q 14 r 15 16 e 17 9 18 19 1a 1b c 1c 1d o 13 1e c 1f 1g 1h e 1i e 1j 1k r 1 1l 1m 9 1n 1o 1 w 3 d 1p g 1q 1r o p 1s 1t 1u 19 e 1v 1a 1b 1w 1c c 1x 1d 1y e 1z 20 21 p 22 23 14 r s 9 24 25 26 27 28 29 x 2a c 2b 2c 2d 2e 2f e 2g 2h 2i e 2j 1q 3 1s 2k 2l k 2m 19 2n 3 2o 9 q k 1 w 3 d 2p 2q 2r 7 2s 9 a g s 2t 2u 2v q e 3 2w 2x x 2y z 2z 30 31 32 33 34 35 1u 21 36 p 37 38 1l 39 c 1f 3a 3b 3c e 3d 3e r s 3f 3g 3h 3i e 3j e 3k 3l 1h 3m 1i 3n e 3o 3p 3q 3r 15 17 e 3s 9 3t 29 q t 3u e 3v 10 11 3w 1f 3x 3y 3z 40 41 42 43 44 17 45 17 46 47 e 48 49 4a 4b 1a 4c 17 42 e 3q 3r 27 28 29 x 2a c 4d e 4e 4f r 2e 2d 2c e 2g 2h 4g 4h r 4i s e 3y 3z 4j 4k 4l 41 4m e 4n 4o 1d 4p 40 4q 4r 4s 4t 4u 4v 4w 4x 4y e 1y 4z 50 e 51 52 53 54 e 55 56 1a 57 19 9 58 59 5a e 5b 1u 4h 0 o 30 5c 5d 1u 4f k 48 5e e 1l 5f r 5g c e 5h 5i 40 5j 5k e 5l 4h 5m 1u 5n 5o 30 7 5p 6 5q w x 5r 5s b 5t k 2u 5u 5v k 2u 5w e 5x k 2p 5y 5z 60 61 6 19 e 1v 3x 25 1f e 3p q t 62 63 9 64 q 9 17 e 65 66 67 68 60 69 2u 35 6a 6b c 5h 6c e 6d 4b 27 28 29 6e 6f 6g 6h 6i 6j 6k 6a 1n 6l 50 r 6m 6n 6o 6p e 6q 6r 6s 6t 6a 6u 6v r 6w 3s e s 6x 6y 6z 70 e 2y 26 71 5t 0 l 72 40 73 e z 74 6a 75 76 e 77 1l 2b 78 r 79 7a 7b e 7c 2r 7d 7e 7f 2r 7d 7g o 4 5l 7h 7i e 7j 9 7k r b 7l 7m 6y 9 7i 7n 7o 7p"
  },
  {
    "id": "janestreet-8810604002",
    "site": "janestreet",
    "title": "Cybersecurity Engineer - Security Operations Center (SOC)",
    "companyName": "Jane Street",
    "jobUrl": "https://www.janestreet.com/join-jane-street/apply/8810604002?gh_jid=8810604002",
    "location": {
      "city": "Hong Kong",
      "country": "Hong Kong SAR China",
      "text": "Hong Kong, Hong Kong"
    },
    "locations": [
      {
        "city": "Hong Kong",
        "country": "Hong Kong SAR China",
        "text": "Hong Kong, Hong Kong"
      }
    ],
    "isRemote": false,
    "employmentType": "Summer Internship",
    "datePosted": "2026-09-16",
    "department": "Cybersecurity",
    "atsType": "greenhouse",
    "description": "0 1 2 g 7q 2r 9 7r o 5l 7s 7t 1u 7u 7v 3w 5s 9 q 7w 10 11 7x 7y 7z 80 81 5l 82 83 84 4f 85 7 86 o 13 87 88 r 7x 7y 89 8a 8b 85 8c 23 r o 4j 7s 8d 19 3 8e 8f 32 3 4 5 6 8g e 8h 8i 8j k 8k e 8l 9 8m b k g 8n 8o 8p 6 5l 8q 8r g 8q 8s 8t 8u 6 8v 4j 1 8w 8x 1u 8y 1 8z 1a 90 91 1c 92 e 93 94 85 95 85 5n 72 e 96 9 75 97 e 98 76 e 99 g 9a g 8q 1m 2r 5l 9b 9c 1u 9d e 8k 9e 8a 8t 9f 9 9g 1 8z 9h 3 9i 9j 9 87 9k 27 9l k 1 9m 8q 9n e 3 6a 9o 1 9p 9q 1 9r 9s 9t 9u 8k 9v e 7u 8e 9w k g 2q 9 2q q 7z 9x 1 9y 1u 7 9z o 13 87 a0 a1 a2 1c a3 a4 e a5 e a6 9 a7 o 13 a8 7 a9 1u 5l aa ab 1u ac ad ae e af ag k ah ai 6n 53 aj 7z 9x 1 9y 1u 7 ak o 13 al am an ao e ap 7s 6k r aq ar x 3 6a as e at au av e 7w aw o p 80 al z 9 8b 85 7 ax 1u 2v ao 9 1 ay 1u 1 8z 5l az b0 1u g b1 2r 9 b2 b3 7w 1 8z b4 r b 4j 1 8q b5 e o b6 87 b7 9 al z 3 b8 0 8k b9 ba e bb e 9 bc 1 8z 0 bd e 2v ao r x k be al bf 0 10 11 3w 8r bg bh 0 o 7g o bi bj bk 0 5l bl k bm o 4 k am bn bo 1u b bp k 1 bq 2 33 4h bh 7g o 30 5l 5t be 5l br bs e 5l bt 6 bu bv 6k 3 30 5l bw o 13 bx by k 3 4 bf 8j k z o b8 e al 6h 7u o bz c0 o b6 87 bz c1 6n 1w 9 c2 k c3 c4 6n 5l c5 4t 8j k 8q e 8l k c6 c7 c8 1c c9 ca 85 cb cc cd e 6n c7 an 19 5l 5g ce 8a 6a cf cg ch e 7 ci 6 cj 8j k c6 72 40 c6 ck c3 cl cm cn co cp r cq cr e 63 9 6v 6u c6 a9 1u b9 ba cs 7v ct 9 8k bd e cu 63 9 cv 1 8q 50 o bi cw k c6 cx c8 e z o bi cy cz 0 d0 50 63 9 d1 9 6o d2 e 1n d3 50 d4 d5 d6 0 7u o c0 e d7 d8 c0 d9 da 9 db dc e dd de 5l 5t df dg r 5l dh br di dj 8a dk dl e dm cs a0 e cj l 2z dn do 5l dp dq a9 dr k ds"
  },
  {
    "id": "janestreet-8746100002",
    "site": "janestreet",
    "title": "Banking Systems and Controls Specialist",
    "companyName": "Jane Street",
    "jobUrl": "https://www.janestreet.com/join-jane-street/apply/8746100002?gh_jid=8746100002",
    "location": {
      "city": "New York",
      "state": "NY",
      "country": "United States",
      "text": "New York, New York, United States"
    },
    "locations": [
      {
        "city": "New York",
        "state": "NY",
        "country": "United States",
        "text": "New York, New York, United States"
      }
    ],
    "isRemote": false,
    "employmentType": "Full-Time: Experienced",
    "datePosted": "2026-09-10",
    "department": "Banking",
    "atsType": "greenhouse",
    "description": "0 1 2 3 8t 5 6 5l dt ae e du 3y 9 8m g dv dt 4p 1m dw 2r 8u 6 dx dy dz e0 e1 e2 e e3 dz du k 21 36 o p ag e4 4j 3x 10 11 3w e0 dx e5 e 1 3q du e6 1 e5 x 65 g e3 21 e7 e8 e e9 e5 7w ea 6c eb ec ed 3q du k ae e ee 1u e3 e 81 4e y e ef 4p 6 eg e3 eh 34 35 1u 21 36 p 37 ei e 3x dx dy e e3 du ej 19 r 15 dt 3z e 3q 3r ek 85 5l el em 6 en 6d e 5h y ej 9 g e0 dx e5 e3 du e eo ep eq er e e9 g es et 1u dx e5 e eu ev r ew 3q 3r t 1 8z 9 y ex e3 dz 1q e ey 3x g e0 ez f0 bg e ez f0 4p dw e7 f1 l f2 3x f3 e 3p r 1 dx 4j f4 f5 f6 r f7 f8 f9 dz e 1 fa 1u fb dx e 6c e5 fc fd 4h k fe r g ff fg fh 1m 9 77 e 97 3e 85 5l 8z e 23 r g h 1m 9 3t 3e fi fj t fk 1u 10 11 3w i 0 o 30 fl 5d 1u fm 4f e 5l fn 3w fo k fp ff 6n 5l ej 4t 30 5l 5g a9 1u dx dy dz 40 fq d9 fr 9 3q du e e0 fs e9 ft fu 4e fv dz e e0 dt fw fx 5l 9b df dg r 5g 5h ci 7 fy 1l fz r fp g0 k 3x 3q g1 e 15 dt 3z g2 r 5l g3 g4 9 5y e g5 g6 e g7 63 9 g8 al g9 ga 40 fq d9 fr 9 f7 e gb 4e gc e gd 63 9 ge 25 1f e q gf k 5l d3 gg gh cl 5l g8 gi r 5g gj e gk 5i gl e gm 63 9 ge gn 6p r go cp r gp ep e h eo gq gr gs gp gt gu gv gw 5z 4h r gx e gy 9 97 gz 3e h0 r h1 h2 h1 h3 e 6n h4 h5 ck 2r 5l h6 h0 r h7 h8 h9 ha e 6n eo hb 2r 5l h6 7g o 4 5l 7h 7i e 7j 9 7k r b 7l 7m 6y 9 7i 7n 7o 7p"
  },
  {
    "id": "janestreet-8733113002",
    "site": "janestreet",
    "title": "Compliance Specialist, Control Room",
    "companyName": "Jane Street",
    "jobUrl": "https://www.janestreet.com/join-jane-street/apply/8733113002?gh_jid=8733113002",
    "location": {
      "city": "Hong Kong",
      "country": "Hong Kong SAR China",
      "text": "Hong Kong, Hong Kong"
    },
    "locations": [
      {
        "city": "Hong Kong",
        "country": "Hong Kong SAR China",
        "text": "Hong Kong, Hong Kong"
      }
    ],
    "isRemote": false,
    "employmentType": "Full-Time: Experienced",
    "datePosted": "2026-08-30",
    "department": "Legal and Compliance",
    "atsType": "greenhouse",
    "description": "0 1 2 3 8t 5 6 7 fy hc 3y 9 cx e 99 g cn hd he k 8n 8o 21 1m hf cs 10 11 b6 hg hh 5l hi 6 hj 7g 3 bi 31 hk hl 4j 5l hm 6n hn 9 ho 6n hp hq hr g hh fp k hs 2r dv ht e 1 hu e ab 1u hv 3 ge 2r dv r 7v 4j hw hx 2q o hy 87 hz 5l i0 1c 7u 74 6a e 6a d8 2t 7z 5l i1 2r i2 4h r g h i3 i4 1m 4j 5l 7y gn i5 6n i6 i7 5l l ho i8 i9 ia 3 65 34 35 1u 1 36 p 37 ib 2q 9 2q i1 3e ic 9 ic 40 id 1 ie 1u if ig 55 e ih hv e ii 9g ij ik g fp an 1m e hp 3r 4j 7u 5l i1 il k im in 1 io e ip iq 2m fp 8x e 3e e 9g 66 ir 85 g fp ae e is 4v it ho e iu iv hh hv e iw 6 hw ix x iy b iz j0 j1 j2 j3 e 6p j4 e j5 hd j6 j7 j8 2r j9 ja 9 d e jb g cn hd he 69 7y 0 o 30 5c 5d 1u hc 4f 7w 5l 6c jc r jd 7y k 5l cn hd 6n i3 i4 hc 6n je jf jg he 30 5l cg fo 1u h0 r hk jh 6p ji e j8 du q k im 5z jj jk 6n jl jm d4 7y d5 5l 5g jn jo 8a 6a jp jq e jr js 85 jt 5l 5g ju jo 8a 2r jv 1u jw r ik 9 jx i2 e jy jz e k0 66 27 hc 26 cp r k1 hq k2 8n 8o e k3 k4 e r ho k5 k6 h hh dr k ds 7g o 4 5l 7h 7i e 7j 9 7k r b 7l 7m 6y 9 7i 7n 7o 7p"
  },
  {
    "id": "janestreet-8631912002",
    "site": "janestreet",
    "title": "Accounting Coordinator",
    "companyName": "Jane Street",
    "jobUrl": "https://www.janestreet.com/join-jane-street/apply/8631912002?gh_jid=8631912002",
    "location": {
      "city": "New York",
      "state": "NY",
      "country": "United States",
      "text": "New York, New York, United States"
    },
    "locations": [
      {
        "city": "New York",
        "state": "NY",
        "country": "United States",
        "text": "New York, New York, United States"
      }
    ],
    "isRemote": false,
    "employmentType": "Full-Time: Experienced",
    "datePosted": "2026-08-19",
    "department": "Accounting",
    "atsType": "greenhouse",
    "description": "0 1 2 3 8t 5 6 7 g2 e k7 ff k8 9 k9 5l ab 1u en ka e 19 t g h ff 1m o d7 d8 8f 9 87 7 kb k ff 9 kc k 21 36 3 8t kd 9 ke o 7u o 8f 9 c0 o 13 al 1a kf s z 9 k9 1 kg kh x ki g ae e 3e ib kj 34 35 1u 21 36 hy 37 3p f9 kk e kl km f6 r kn dz 2j e ko kp kq ej ka ca 85 4z kr e 3p r hp 10 11 3r 9 3t ks kl kt ku kv kw 9 kx e9 1 ky jg e ko 7v 85 eu e 26 4v 3p 6c kz l0 r 1 l1 1m l2 l3 f6 r ez f0 4p 40 f1 l f2 3x f3 l4 r l5 l6 42 e 3p r l7 k 1 l8 1u f4 f5 3p ea 3e 40 i3 l9 e f7 21 36 la 5l lb lc 9 g ff he e 1 ld e2 1u 1 8z le 1 3o by k ff 2r 7 lf lg b0 1u g fp e 3 1s 2l k g lh 9 li 4j 2d 68 lj g5 lk ll 1u g 1m 2r lm g2 ln e 63 9 lo ka gf 0 o lp lq 5d 1u e0 lr 4f 2r 7d 63 9 jp ls e ir lt k4 q lu js lv e lw 5l 1m lx r 5l br ly lm g2 r lz g4 9 5y k7 gm e 5z 4h k 5l m0 iv cl m1 9 77 3e j7 m2 5l 5g jo r m3 m4 5i m5 r m6 7c 7g o 4 5l 7h 7i e 7j 9 7k r b 7l 7m 6y 9 7i 7n 7o 7p"
  },
  {
    "id": "janestreet-8632723002",
    "site": "janestreet",
    "title": "Cybersecurity Engineer - Security Operations Center (SOC)",
    "companyName": "Jane Street",
    "jobUrl": "https://www.janestreet.com/join-jane-street/apply/8632723002?gh_jid=8632723002",
    "location": {
      "city": "New York",
      "state": "NY",
      "country": "United States",
      "text": "New York, New York, United States"
    },
    "locations": [
      {
        "city": "New York",
        "state": "NY",
        "country": "United States",
        "text": "New York, New York, United States"
      }
    ],
    "isRemote": false,
    "employmentType": "Summer Internship",
    "datePosted": "2026-07-15",
    "department": "Cybersecurity",
    "atsType": "greenhouse",
    "description": "0 1 2 g 7q 2r 9 7r o 5l 7s 7t 1u 7u 7v 3w 5s 9 q 7w 10 11 7x 7y 7z 80 81 5l 82 83 84 4f 85 7 86 o 13 87 88 r 7x 7y 89 8a 8b 85 8c 23 r o 4j 7s 8d 19 3 8e 8f 32 3 4 5 6 8g e 8h 8i 8j k 8k e 8l 9 8m b k g l m 8p 6 5l 8q 8r g 8q 8s 8t 8u 6 8v 4j 1 8w 8x 1u 8y 1 8z 1a 90 91 1c 92 e 93 94 85 95 85 5n 72 e 96 9 75 97 e 98 76 e 99 g 9a g 8q 1m 2r 5l 9b 9c 1u 9d e 8k 9e 8a 8t 9f 9 9g 1 8z 9h 3 9i 9j 9 87 9k 27 9l k 1 9m 8q 9n e 3 6a 9o 1 9p 9q 1 9r 9s 9t 9u 8k 9v e 7u 8e 9w k g 2q 9 2q q 7z 9x 1 9y 1u 7 9z o 13 87 a0 a1 a2 1c a3 a4 e a5 e a6 9 a7 o 13 a8 7 a9 1u 5l aa ab 1u ac ad ae e af ag k ah ai 6n 53 aj 7z 9x 1 9y 1u 7 ak o 13 al am an ao e ap 7s 6k r aq ar x 3 6a as e at au av e 7w aw o p 80 al z 9 8b 85 7 ax 1u 2v ao 9 1 ay 1u 1 8z 5l az b0 1u g b1 2r 9 b2 b3 7w 1 8z b4 r b 4j 1 8q b5 e o b6 87 b7 9 al z 3 b8 0 8k b9 ba e bb e 9 bc 1 8z 0 bd e 2v ao r x k be 7g o 4 5l 7h 7i e 7j 9 7k r b 7l 7m 6y 9 7i 7n 7o 7p al bf 0 10 11 3w 8r bg bh 0 o 7g o bi bj bk 0 5l bl k bm o 4 k am bn bo 1u b bp k 1 bq 2 33 4h bh 7g o 30 5l 5t be 5l br bs e 5l bt 6 bu bv 6k 3 30 5l bw o 13 bx by k 3 4 bf 8j k z o b8 e al 6h 7u o bz c0 o b6 87 bz c1 6n 1w 9 c2 k c3 c4 6n 5l c5 4t 8j k 8q e 8l k c6 c7 c8 1c c9 ca 85 cb cc cd e 6n c7 an 19 5l 5g ce 8a 6a cf cg ch e 7 ci 6 cj 8j k c6 72 40 c6 ck c3 cl cm cn co cp r cq cr e 63 9 6v 6u c6 a9 1u b9 ba cs 7v ct 9 8k bd e cu 63 9 cv 1 8q 50 o bi cw k c6 cx c8 e z o bi cy cz 0 d0 50 63 9 d1 9 6o d2 e 1n d3 50 d4 d5 d6 0 7u o c0 e d7 d8 c0 d9 da 9 db dc e dd de 5l 5t df dg r 5l dh br di dj 8a dk dl e dm cs a0 e cj l 2z dn do 5l dp dq a9"
  },
  {
    "id": "janestreet-8613910002",
    "site": "janestreet",
    "title": "Cybersecurity Engineer - Security Operations Center (SOC)",
    "companyName": "Jane Street",
    "jobUrl": "https://www.janestreet.com/join-jane-street/apply/8613910002?gh_jid=8613910002",
    "location": {
      "city": "New York",
      "state": "NY",
      "country": "United States",
      "text": "New York, New York, United States"
    },
    "locations": [
      {
        "city": "New York",
        "state": "NY",
        "country": "United States",
        "text": "New York, New York, United States"
      }
    ],
    "isRemote": false,
    "employmentType": "Full-Time: New Grad",
    "datePosted": "2026-07-06",
    "department": "Cybersecurity",
    "atsType": "greenhouse",
    "description": "0 1 2 3 4 5 9 m7 5l 8g 8q ak 9 g l m 8p 9 a m8 10 11 3w 89 gx e m9 1a 1 ma 1u 1 mb g 8q 8s 8t 8u 6 3f e mc iw 72 9 md 1 8z 85 95 85 it 93 94 e me cs 5l cq 2r mf g 8q 1m 2r 5l 9b 9c 1u 9d e 8k 9e 8a 8t 9f 9 9g 1 8z 9h 3 9i 9j 9 87 9k 27 9l k 1 9m 8q 9n e 6a 9o 1 9p 9q 1 9r 9s 9t 9u 8k 9v e 7u 8e 9w k g 2q 9 2q k 21 36 o 13 mg 9i 1 mh 1u g 50 85 3 b8 0 1 mi 3 4 jj k g mj 9 52 8q 54 3 13 mk o 9 ml 5l mm mj 9 mn mo 92 9 mp e mq 1 aj 1u 5l 8k mr o p 80 8b 85 7 ax 1u 2v ao 9 1 ay 1u 1 8z 1m ms jx e im am c7 8q mt e 8t 63 9 mu 9 6z 0 7v 5l az mv 1u mw 95 k 21 2 2r mx b3 my b4 r o 4j 1 8q b5 e o b6 87 b7 9 al 1a c6 s e mz x cj 4j 9 l 8s 0 o n0 r 5l fn 3w fo k c3 c4 n1 6p ae 6n 5l ej 4t 7 n2 n3 1u 8q n4 5l 5g ce 8a 6a cf cg ch e 7 ci 6 cj 5z e 8j k 3x c6 aq e n5 k cm cn e 5m 1u c6 ck 3 d7 d8 go dw n6 cp r cq cr e 63 9 6v 6u c6 a9 1u 1 mi 3 4 jj 9 3q g1 63 9 cv 1 8q 50 o bi cw k c6 cx c8 e z o bi cy cz 0 d0 50 63 9 d1 9 6o d2 e 1n d3 50 d4 d5 d6 di 0 7u o c0 e d7 d8 c0 d9 da 9 db dc e dd de 5t df dg r 5l dh br di"
  },
  {
    "id": "janestreet-8594336002",
    "site": "janestreet",
    "title": "Compiler Engineer",
    "companyName": "Jane Street",
    "jobUrl": "https://www.janestreet.com/join-jane-street/apply/8594336002?gh_jid=8594336002",
    "location": {
      "city": "London",
      "state": "England",
      "country": "United Kingdom"
    },
    "locations": [
      {
        "city": "London",
        "state": "England",
        "country": "United Kingdom"
      }
    ],
    "isRemote": false,
    "employmentType": "Full-Time: Experienced",
    "datePosted": "2026-06-26",
    "department": "Software Engineering",
    "atsType": "greenhouse",
    "description": "0 1 2 3 8t 5 6 7 fy n7 ak 9 q 4j aq n8 k 1 n9 na dw 2r 53 aj n9 2r 10 11 3w nb 1u 1 nc nd ne r nf ng 6 cg nh e ni nj r gx nk nl nm 21 36 nn 1 7x no 1u 6e l np nq nr ns e nt nu p 87 1 2s 9 q t 5l aa ab 1u nv nw 40 nx ny e nz o0 o1 1u o2 21 36 p 80 o3 o 9 o4 r bo o5 o6 e lz o7 t 10 11 o8 0 o 1 o9 oa p 87 ob oc gg 7w od oe aq of 9 og 73 oh 9 2o ix 9 oi av e fy r oj gr gs ok ol e om dq on 72 lp 5m 1u oo op e oq or 7w 1 os nd e 7e dq 2r 5l h6 3 8t kd 9 9i ot r 4f 4j hw na ou ov 5m 1u ow ox 87 oy oz 5m 1u 1 nc 6n n9 p0 2r p1 3 6a ke o 7u o 8f 9 c0 3 8t p2 8j k ot 8a 30 p3 4f 3x 5l 1m 1u p4 e 8a ox p5 mw x p6 2u p7 5h q p8 k ds 2r p1 7g o 4 5l 7h 7i e 7j 9 7k r b 7l 7m 6y 9 7i 7n 7o 7p"
  },
  {
    "id": "janestreet-8596771002",
    "site": "janestreet",
    "title": "ꓟachine ꓡearning ꓣesearcher",
    "companyName": "Jane Street",
    "jobUrl": "https://www.janestreet.com/join-jane-street/apply/8596771002?gh_jid=8596771002",
    "location": {
      "city": "Hong Kong",
      "country": "Hong Kong SAR China",
      "text": "Hong Kong, Hong Kong"
    },
    "locations": [
      {
        "city": "Hong Kong",
        "country": "Hong Kong SAR China",
        "text": "Hong Kong, Hong Kong"
      }
    ],
    "isRemote": false,
    "employmentType": "Summer Internship",
    "datePosted": "2026-06-22",
    "department": "Machine Learning",
    "atsType": "greenhouse",
    "description": "0 1 2 g p9 8t 9 7r o 5l 7s 7t 1u 7u 7v 3w 5s 9 q 7w 10 11 85 5l pa cj pb 7z 80 81 5l 82 83 84 4f o 13 q pc 9u pc r fy pd 9v 4j 19 x 3 bi pe 6 2u pf 1u pg pd 2x e ph 9 7s 8d pi hh pj o 13 al z 3 b8 0 i4 1c d3 pk e c9 e im mc pl pm p6 g cx pn po 9 pp 28 pq 7w 10 11 1 8x 9q pr 8l e hh 8t ps pt e o 13 30 fv 9 pu 1u gx 5l pv pw r px 1u py 1u pz e 5l dv q0 pw q1 q2 1u py 1u cg ic q3 hh q4 q5 q6 q7 pq e q8 q9 k 5l qa qb qc cl x qd b 9 qe 6 pg qf o 13 qg 1 qh 1u c6 8r 4h 14 r 7x 7y pa cj 9v 4j 19 qi 1a 2u cx q o hy qj 7 ic 9 ic qk 1u 7 ql qm qn 5l l cr qo 6 5l qp df 6n 9i qq qr qs x 3 4 qt qu 9 qv 6y 1 6k 3 q 4j qw 30 j5 qx qy e 74 qz 22 r0 1a s t 1 8z r o5 r1 1u 70 r2 4j 1 2q o hy 87 r3 r4 27 r5 gx r6 r7 r8 r9 54 6n ra 1 rb c6 rc rd re x hx 1 rf gn rg 1u pa cj pr 7w 10 11 7v 2r rh x hw pr ri rj r 1 8r p 87 rk 6 rl rm rn 0 o 7g o bi bj bk 0 5l bl k bm o 4 k am bn bo 1u b bp k 1 bq 2 33 4h bh 7g o 30 5l 5t be e 5l bt 6 bu bv 6k 3 30 5l bw o 13 bx by k 3 4 bf 8j k z o b8 e al 6h 7u o bz c0 o b6 87 7 ro rp rq 6n rr r 28 4f 4h 4j pd 6k 8j k 55 rs e rt cz 9 fk ru 1u 6k 5t 0 1 pa cj rv e b7 9 ml rw 1u 1 rx qf qi 1a bo df ry dr r 5l rz 1e 1u pq e s0 63 9 s1 s2 e s3 4j c6 2x k s4 e c6 s5 pd s6 gy 9 db dc dd de e al l 2z dr k ds 7g o s7 5s 9 al bf o 6a s8 0 g s9 fd e 1p sa 1u 1 1m al bf 0 10 11 3w 8r bg bh sb 3w sc d8 sd sc se d8 p sf sg sh d8 si sj sk sl sm sn sm si so s7 sp sc sq sr ss st su sv sw st sf sx sk"
  },
  {
    "id": "janestreet-8599605002",
    "site": "janestreet",
    "title": "Compute & Storage Infrastructure Sourcing Lead ",
    "companyName": "Jane Street",
    "jobUrl": "https://www.janestreet.com/join-jane-street/apply/8599605002?gh_jid=8599605002",
    "location": {
      "city": "New York",
      "state": "NY",
      "country": "United States",
      "text": "New York, New York, United States"
    },
    "locations": [
      {
        "city": "New York",
        "state": "NY",
        "country": "United States",
        "text": "New York, New York, United States"
      }
    ],
    "isRemote": false,
    "employmentType": "Full-Time: Experienced",
    "datePosted": "2026-06-22",
    "department": "Procurement",
    "atsType": "greenhouse",
    "description": "0 1 2 10 11 3w sy sz 2r dv gg e 3 4 5 6 dj 8a 6a y t0 t t1 t2 e t3 m9 21 2 p 87 7w 1 t4 1u g 8l t5 r 5l e4 4j dv g t6 eu e t7 g 7n r g t8 eg 42 1 o9 oa 2r 5l t9 r 1 ta e tb 9 99 2m 9a dj 8a 2r tc 5z 3x td te tf e ev r g 8s 9v e ik 9 tg e 2y g 26 34 35 1u 1 36 p 37 in th eu r ti mv tj t tk t2 e t3 ei 1 7x tl 1u te e 5h tm 6 tn qb to tp tq e tr 1a tj ev r g n1 e m9 3r 9 k0 5h 26 27 ts tt e 9 tu tv pc tw gr gs tx ty tz u0 u1 j2 27 tp 1w u2 u3 e 3x 1 tv u4 u5 1 8z 3w u6 k sy e u7 4h 14 r g t6 1x e u3 1w 3r 9 u8 5l u9 1u mv ua ub uc ud u0 ue 0 o 30 7 a9 1u uf t6 e ti ts e 8t cp r 1 t6 1x e nt c8 no 6 ug uh ui e mv tj o 4 dj 8a uj 5n e uk ua eu ul o 30 um eu r un 6n bf 1u 1 c2 tk t2 6n t3 tj 30 5l r4 4h a9 1u z u0 u1 e uo up uq mv pq q k im fy r ur 2g 2h tv us ut uu 5h uv 9 uw ux r 8s 4j z 3 uy 9 og 1 t6 5z r te uz gr gs v0 tr 1c uc v1 1u 4k it v2 6 v3 uc v4 v5 e v6 v7 e v8 of e 63 9 al 5l l v9 3 d7 d8 mk r4 70 k 2p va 1u 1 tv vb fq 3 2t mk 5l 5g vc vd e 7 lh 9 al ht 5l 5g ve tc 5z 4h vf r 3q 3z e vg vh r 15 42 8j k a9 uf 1 vi dq tt e 1 vj dq 3o 1u g 1x fd 7g o 4 5l 7h 7i e 7j 9 7k r b 7l 7m 6y 9 7i 7n 7o 7p"
  },
  {
    "id": "janestreet-8596349002",
    "site": "janestreet",
    "title": "Compiler Engineer",
    "companyName": "Jane Street",
    "jobUrl": "https://www.janestreet.com/join-jane-street/apply/8596349002?gh_jid=8596349002",
    "location": {
      "city": "New York",
      "state": "NY",
      "country": "United States",
      "text": "New York, New York, United States"
    },
    "locations": [
      {
        "city": "New York",
        "state": "NY",
        "country": "United States",
        "text": "New York, New York, United States"
      }
    ],
    "isRemote": false,
    "employmentType": "Full-Time: Experienced",
    "datePosted": "2026-06-17",
    "department": "Software Engineering",
    "atsType": "greenhouse",
    "description": "0 1 2 3 8t 5 6 7 fy n7 ak 9 q 4j aq n8 k 1 n9 na dw 2r 53 aj n9 2r 10 11 3w nb 1u 1 nc nd ne r nf ng 6 cg nh e ni nj r gx nk nl nm 21 36 nn 1 7x no 1u 6e l vk nq nr ns e nt nu p 87 1 2s 9 q t 5l aa ab 1u nv nw 40 nx ny e nz o0 o1 1u o2 21 36 p 80 o3 o 9 o4 r bo o5 o6 e lz o7 t 10 11 o8 0 o 1 o9 oa p 87 ob oc gg 7w od oe aq of 9 og 73 oh 9 2o ix 9 oi av e fy r oj gr gs ok ol e om dq on 72 lp 5m 1u oo op e oq or 7w 1 os nd e 7e dq 2r 5l h6 3 8t kd 9 9i ot r 4f 4j hw na ou ov 5m 1u ow ox 87 oy oz 5m 1u 1 nc 6n n9 p0 2r p1 3 6a ke o 7u o 8f 9 c0 3 8t p2 8j k ot 8a 30 p3 4f 3x 5l 1m 1u p4 e 8a ox p5 mw x p6 2u p7 5h q 7g o 4 5l 7h 7i e 7j 9 7k r b 7l 7m 6y 9 7i 7n 7o 7p"
  },
  {
    "id": "janestreet-8531243002",
    "site": "janestreet",
    "title": "ASIC Physical Design Engineer",
    "companyName": "Jane Street",
    "jobUrl": "https://www.janestreet.com/join-jane-street/apply/8531243002?gh_jid=8531243002",
    "location": {
      "city": "New York",
      "state": "NY",
      "country": "United States",
      "text": "New York, New York, United States"
    },
    "locations": [
      {
        "city": "New York",
        "state": "NY",
        "country": "United States",
        "text": "New York, New York, United States"
      }
    ],
    "isRemote": false,
    "employmentType": "Full-Time: Experienced",
    "datePosted": "2026-04-30",
    "department": "Software Engineering",
    "atsType": "greenhouse",
    "description": "0 1 2 3 8t 5 9 vl 7 vm vn c ak 8a 2r 80 fy vo e od vp 9 a b c 3h e vq vr t6 85 b0 1u g vs om vt 1m o 13 30 1 2s 9 vu r m4 k r1 t 1 8z 40 hh vv e pr m9 21 vw d8 5l vx vy 36 3 4 5l vz 1m j7 b3 12 t 1 w0 c fd e 3 mk g vy 8s 9 tx r vn c 70 fq b8 5s w0 6w o b6 87 5z in 5l vy w1 ic 9 ic fq 80 63 9 s8 e w2 vp e w3 0 c 50 x w4 1 8w ic j2 ic w5 7g o bi w6 c6 bl w7 k vy 21 w8 vw d8 1 by bx fq 7g o bi w9 t 1 t5 wa 2n o wb 85 7 vp wc e wd 27 vy 6n 2n o bp 4j 5l we 1m j7 o wf 9 wg wh wi 3 s7 wj 9 mu 3 4 wk wl k 1 lh 1u 72 9 77 1 wm wn e 2q 9 2q wo 1u t6 n1 x 3w wp 3 wq wr 5l t6 an ou ws k nc 3 d7 d8 mk o 9 c0 nc 3 13 ke o bh fq 3 8t 5 6 t6 8s 8a 8t b7 0 1 wt x au 72 6a b2 e 8t of 9 qn l 2z 85 5l wu 0 o o 30 wv 5d ww 4j 4f 5n e ib wx vn c jz gr gs wy 1w wz e x0 x1 x2 vn x3 x4 x5 o d7 d8 8f 9 30 x6 2p x7 5y 1u 2p w1 fq o b6 30 x8 uu 4f t vy x o 6a cx 5l w1 ic 9 ic e c0 j7 1 51 8t dn vy o 6a s8 e w2 vp e jx z 8w ic c 50 iy vn x9 e xa xb o b8 0 vn c k 1 mh 1u 1 xc w0 d9 do 85 5l xd xe 1u 5l xf o 4 8j k mc n7 n1 qf 9 77 1 t6 c fd e o 30 4f nj k 5l cg dq nd s4 xg xh co 7g o 4 5l 7h 7i e 7j 9 7k r b 7l 7m 6y 9 7i 7n 7o 7p"
  },
  {
    "id": "janestreet-8469230002",
    "site": "janestreet",
    "title": "Campus Recruiter",
    "companyName": "Jane Street",
    "jobUrl": "https://www.janestreet.com/join-jane-street/apply/8469230002?gh_jid=8469230002",
    "location": {
      "city": "Hong Kong",
      "country": "Hong Kong SAR China",
      "text": "Hong Kong, Hong Kong"
    },
    "locations": [
      {
        "city": "Hong Kong",
        "country": "Hong Kong SAR China",
        "text": "Hong Kong, Hong Kong"
      }
    ],
    "isRemote": false,
    "employmentType": "Full-Time: Experienced",
    "datePosted": "2026-04-27",
    "department": "Recruiting",
    "atsType": "greenhouse",
    "description": "0 1 2 3 8t 5 6 7 fy xi xj 9 a b xk e vl xl xm 9 8m 10 11 3 4 xn 4j dv e xo g 7h xp e 1 oa rv 2r bf qa 6h xq c6 4b p 87 eg 85 3 q 9 li xr 1u 1 xs 3 4 5 6 dj 8a 6a k9 2u cx u4 7z 80 mx xt 2x 9 g mj e 3e 21 p 22 xu 6f 9 wk bv 6k 7z 80 le 1 3o by o p 87 xv k xw 9 99 g 8r e k ah xx xy c6 2q 9 2q q p xz y0 y1 ts e y2 e9 7s 7y y3 k g y4 4z ef e gx gd 72 e f6 r ea y5 y6 g 1m y7 5l 2g ii 1u y8 lb y9 e ya 66 9 2u 7x ch e 3 qg 5l yb 1u 7y yc g l yd 1 ye e yf 1u 7h 7w 10 11 21 e7 5l 5x l3 fd x yg 5l r4 yh 27 g wk yi tt e z 7v yj 9 g en q 69 7y 3 p yk 9 y c6 yl u6 r ww 4j r9 e ym g 7h 1m 2r 7 yn yo yp 1m 1u m4 8a yq 10 11 3w yr ys 8t 1 m4 4h e6 b 3 wj 7u 3 2t e 8a 3 q r e 21 yt g bt 6 yu 6z 7w 1 8z r lb yv 1u 2u cx 69 1 yw yx 5d 3 30 ai 5l yy e v6 qe e s9 fd 9 xk bf 6h yz z0 1u 1 z1 yd 1a fk z2 1u 1 8d e 3 13 z3 4j c6 70 e r0 9 a z4 g tt z5 0 o 30 wv 5d 1u z6 7h 4f oz 6c z7 4f p1 gy 9 al l 5i e 1n 7 z8 z9 4i za r 5l r4 a9 1u 1 oa rv 63 9 a b zb j7 3 8f 9 zc zd 9 xk lb yd g8 gi 8a 6a ze ka li zf e 24 2x 27 zg zh 1m lx r 5l zi kt c6 zj oz zk zl vz di 63 9 6u 6v r s ot e 15 3z zm e d6 0 7u o c0 e d7 d8 c0 d9 da 9 db 6 a 5t 0 1 e2 1u 1 8z e z 7h 3i 27 1 zn yi of e b7 9 zo 9 7h zp e y6 85 jt dr k ds zq zr nd ox 87 5l h6 fq d9 p1 7g o 4 5l 7h 7i e 7j 9 7k r b 7l 7m 6y 9 7i 7n 7o 7p"
  },
  {
    "id": "janestreet-8516108002",
    "site": "janestreet",
    "title": "Cybersecurity Engineer",
    "companyName": "Jane Street",
    "jobUrl": "https://www.janestreet.com/join-jane-street/apply/8516108002?gh_jid=8516108002",
    "location": {
      "city": "Hong Kong",
      "country": "Hong Kong SAR China",
      "text": "Hong Kong, Hong Kong"
    },
    "locations": [
      {
        "city": "Hong Kong",
        "country": "Hong Kong SAR China",
        "text": "Hong Kong, Hong Kong"
      }
    ],
    "isRemote": false,
    "employmentType": "Full-Time: Experienced",
    "datePosted": "2026-04-22",
    "department": "Cybersecurity",
    "atsType": "greenhouse",
    "description": "0 1 2 3 4 5 9 m7 5l 7x 7y 8g 8q ak 9 g 8n 8o 8p 9 a m8 g bn 3w m4 gx e m9 1a 1 ma 1u 1 mb g 8q 8s q 4j 8z aa zs u8 70 e zt 9 hp o6 tx zu 8q zv xp e ge sa 1u 1 l8 x5 e 93 94 35 1u 1 8z 3 4 5 6 dj 8a y7 5l 5g 5h zw 8a 2r d9 da 9 d zx zy 8a zz am 100 9 bu 8k 6k e 8a 6a w3 0 e cv 1 wp iq 8k ao 0 o 30 5g 101 6n nj e 102 ao o 30 7 103 e lh 9 97 k 5l 7s nj nd lh e 104 9 k9 c6 aq e n5 k cm cn e 5m 1u c6 ck 3 d7 d8 go dw ck n6 5l 105 106 d9 b3 b6 87 107 2u 108 109 10a k 1 hi 1u 8k o 6a 10b b9 ba cs 7v ct 9 8q b8 0 mh e jx 7u cq cr 2r o jx e im am c7 8q mt e 6a mu 9 6z 0 7v 6 hj o c0 7u 5l 10c fz 2r e wa og un 6n 30 zx dw o 6a 10d 10e 2r au e 6a 10f dj 1c 1 mi o bi cw 10g 3 13 db o 0 21 10h 1u 10i l2 1 s9 fd o 4 9k 27 8q 9l o kl 8q n4 fq 6a 9o 1 9p 9q 1 9r 9s 9t 9u 8k 9v e 7u 8e 9w k c6 2q 9 2q 30 5l dh e br di o jx x 5l az mv 1u 8q 2r mx 6z b4 r o 4j 1 b5 p8 k ds p1 7g o 4 5l 7h 7i e 7j 9 7k r b 7l 7m 6y 9 7i 7n 7o 7p"
  },
  {
    "id": "janestreet-8057310002",
    "site": "janestreet",
    "title": "Cybersecurity Engineer",
    "companyName": "Jane Street",
    "jobUrl": "https://www.janestreet.com/join-jane-street/apply/8057310002?gh_jid=8057310002",
    "location": {
      "city": "London",
      "state": "England",
      "country": "United Kingdom"
    },
    "locations": [
      {
        "city": "London",
        "state": "England",
        "country": "United Kingdom"
      }
    ],
    "isRemote": false,
    "employmentType": "Full-Time: Experienced",
    "datePosted": "2026-04-21",
    "department": "Cybersecurity",
    "atsType": "greenhouse",
    "description": "0 1 2 3 4 5 9 m7 5l 7x 7y 8g 8q ak 9 g 10j 8p 9 a m8 g bn 3w m4 gx e m9 1a 1 ma 1u 1 mb g 8q 8s q 4j 8z aa zs u8 70 e zt 9 hp o6 tx zu 8q zv xp e ge sa 1u 1 l8 x5 e 93 94 35 1u 1 8z 3 4 5 6 dj 8a y7 5l 5g 5h zw 8a 2r d9 da 9 d zx zy 8a zz am 100 9 bu 8k 6k e 8a 6a w3 0 e cv 1 wp iq 8k ao 0 o 30 5g 101 6n nj e 102 ao o 30 7 103 e lh 9 97 k 5l 7s nj nd lh e 104 9 k9 c6 aq e n5 k cm cn e 5m 1u c6 ck 3 d7 d8 go dw ck n6 5l 105 106 d9 b3 b6 87 107 2u 108 109 10a k 1 hi 1u 8k o 6a 10b b9 ba cs 7v ct 9 8q b8 0 mh e jx 7u cq cr 2r o jx e im am c7 8q mt e 6a mu 9 6z 0 7v 6 hj o c0 7u 5l 10c fz 2r e wa og un 6n 30 zx dw o 6a 10d 10e 2r au e 6a 10f dj 1c 1 mi o bi cw 10g 3 13 db o 0 21 10h 1u 10i l2 1 s9 fd o 4 9k 27 8q 9l o kl 8q n4 fq 6a 9o 1 9p 9q 1 9r 9s 9t 9u 8k 9v e 7u 8e 9w k c6 2q 9 2q 30 5l dh e br di o jx x 5l az mv 1u 8q 2r mx 6z b4 r o 4j 1 b5 p8 k ds 7g o 4 5l 7h 7i e 7j 9 7k r b 7l 7m 6y 9 7i 7n 7o 7p"
  },
  {
    "id": "janestreet-8057314002",
    "site": "janestreet",
    "title": "Cybersecurity Engineer",
    "companyName": "Jane Street",
    "jobUrl": "https://www.janestreet.com/join-jane-street/apply/8057314002?gh_jid=8057314002",
    "location": {
      "country": "Singapore"
    },
    "locations": [
      {
        "country": "Singapore"
      }
    ],
    "isRemote": false,
    "employmentType": "Full-Time: Experienced",
    "datePosted": "2026-04-21",
    "department": "Cybersecurity",
    "atsType": "greenhouse",
    "description": "0 1 2 3 4 5 9 m7 5l 7x 7y 8g 8q ak 9 g 10k 8p 9 a m8 g bn 3w m4 gx e m9 1a 1 ma 1u 1 mb g 8q 8s q 4j 8z aa zs u8 70 e zt 9 hp o6 tx zu 8q zv xp e ge sa 1u 1 l8 x5 e 93 94 35 1u 1 8z 3 4 5 6 dj 8a y7 5l 5g 5h zw 8a 2r d9 da 9 d zx zy 8a zz am 100 9 bu 8k 6k e 8a 6a w3 0 e cv 1 wp iq 8k ao 0 o 30 5g 101 6n nj e 102 ao o 30 7 103 e lh 9 97 k 5l 7s nj nd lh e 104 9 k9 c6 aq e n5 k cm cn e 5m 1u c6 ck 3 d7 d8 go dw ck n6 5l 105 106 d9 b3 b6 87 107 2u 108 109 10a k 1 hi 1u 8k o 6a 10b b9 ba cs 7v ct 9 8q b8 0 mh e jx 7u cq cr 2r o jx e im am c7 8q mt e 6a mu 9 6z 0 7v 6 hj o c0 7u 5l 10c fz 2r e wa og un 6n 30 zx dw o 6a 10d 10e 2r au e 6a 10f dj 1c 1 mi o bi cw 10g 3 13 db o 0 21 10h 1u 10i l2 1 s9 fd o 4 9k 27 8q 9l o kl 8q n4 fq 6a 9o 1 9p 9q 1 9r 9s 9t 9u 8k 9v e 7u 8e 9w k c6 2q 9 2q 30 5l dh e br di o jx x 5l az mv 1u 8q 2r mx 6z b4 r o 4j 1 b5 p8 k ds 7g o 4 5l 7h 7i e 7j 9 7k r b 7l 7m 6y 9 7i 7n 7o 7p"
  },
  {
    "id": "janestreet-8515327002",
    "site": "janestreet",
    "title": "Cybersecurity Engineer",
    "companyName": "Jane Street",
    "jobUrl": "https://www.janestreet.com/join-jane-street/apply/8515327002?gh_jid=8515327002",
    "location": {
      "city": "New York",
      "state": "NY",
      "country": "United States",
      "text": "New York, New York, United States"
    },
    "locations": [
      {
        "city": "New York",
        "state": "NY",
        "country": "United States",
        "text": "New York, New York, United States"
      }
    ],
    "isRemote": false,
    "employmentType": "Full-Time: Experienced",
    "datePosted": "2026-04-20",
    "department": "Cybersecurity",
    "atsType": "greenhouse",
    "description": "0 1 2 3 4 5 9 m7 5l 7x 7y 8g 8q ak 9 g l m 8p 9 a m8 g bn 3w m4 gx e m9 1a 1 ma 1u 1 mb g 8q 8s q 4j 8z aa zs u8 70 e zt 9 hp o6 tx zu 8q zv xp e ge sa 1u 1 l8 x5 e 93 94 35 1u 1 8z 3 4 5 6 dj 8a y7 5l 5g 5h zw 8a 2r d9 da 9 d zx zy 8a zz am 100 9 bu 8k 6k e 8a 6a w3 0 e cv 1 wp iq 8k ao 0 o 30 5g 101 6n nj e 102 ao o 30 7 103 e lh 9 97 k 5l 7s nj nd lh e 104 9 k9 c6 aq e n5 k cm cn e 5m 1u c6 ck 3 d7 d8 go dw ck n6 5l 105 106 d9 b3 b6 87 107 2u 108 109 10a k 1 hi 1u 8k o 6a 10b b9 ba cs 7v ct 9 8q b8 0 mh e jx 7u cq cr 2r o jx e im am c7 8q mt e 6a mu 9 6z 0 7v 6 hj o c0 7u 5l 10c fz 2r e wa og un 6n 30 zx dw o 6a 10d 10e 2r au e 6a 10f dj 1c 1 mi o bi cw 10g 3 13 db o 0 21 10h 1u 10i l2 1 s9 fd o 4 9k 27 8q 9l o kl 8q n4 fq 6a 9o 1 9p 9q 1 9r 9s 9t 9u 8k 9v e 7u 8e 9w k c6 2q 9 2q 30 5l dh e br di o jx x 5l az mv 1u 8q 2r mx 6z b4 r o 4j 1 b5 7g o 4 5l 7h 7i e 7j 9 7k r b 7l 7m 6y 9 7i 7n 7o 7p"
  },
  {
    "id": "janestreet-8512072002",
    "site": "janestreet",
    "title": "ASIC Physical Design Engineer",
    "companyName": "Jane Street",
    "jobUrl": "https://www.janestreet.com/join-jane-street/apply/8512072002?gh_jid=8512072002",
    "location": {
      "city": "London",
      "state": "England",
      "country": "United Kingdom"
    },
    "locations": [
      {
        "city": "London",
        "state": "England",
        "country": "United Kingdom"
      }
    ],
    "isRemote": false,
    "employmentType": "Full-Time: Experienced",
    "datePosted": "2026-04-17",
    "department": "Software Engineering",
    "atsType": "greenhouse",
    "description": "0 1 2 3 8t 5 9 vl 7 vm vn c ak 8a 2r 80 fy vo e od vp 9 a b c 3h e vq vr t6 85 b0 1u g vs om vt 1m o 13 30 1 2s 9 vu r m4 k r1 t 1 8z 40 hh vv e pr m9 21 vw d8 5l vx vy 36 3 4 5l vz 1m j7 b3 12 t 1 w0 c fd e 3 mk g vy 8s 9 tx r vn c 70 fq b8 5s w0 6w o b6 87 5z in 5l vy w1 ic 9 ic fq 80 63 9 s8 e w2 vp e w3 0 c 50 x w4 1 8w ic j2 ic w5 7g o bi w6 c6 bl w7 k vy 21 w8 vw d8 1 by bx fq 7g o bi w9 t 1 t5 wa 2n o wb 85 7 vp wc e wd 27 vy 6n 2n o bp 4j 5l we 1m j7 o wf 9 wg wh wi 3 s7 wj 9 mu 3 4 wk wl k 1 lh 1u 72 9 77 1 wm wn e 2q 9 2q wo 1u t6 n1 x 3w wp 3 wq wr 5l t6 an ou ws k nc 3 d7 d8 mk o 9 c0 nc 3 13 ke o bh fq 3 8t 5 6 t6 8s 8a 8t b7 0 1 wt x au 72 6a b2 e 8t of 9 qn l 2z 85 5l wu 0 o o 30 wv 5d ww 4j 4f 5n e ib wx vn c jz gr gs 10l wz e x0 x1 x2 vn x3 x4 x5 o d7 d8 8f 9 30 10m 2p x7 5y 1u 2p w1 fq o b6 30 x8 uu 4f t vy x o 6a cx 5l w1 ic 9 ic e c0 j7 1 51 8t dn vy o 6a s8 e w2 vp e jx z 8w ic c 50 iy vn x9 e xa xb o b8 0 vn c k 1 mh 1u 1 xc w0 d9 do 85 5l xd xe 1u 5l xf o 4 8j k mc n7 n1 qf 9 77 1 t6 c fd e o 30 4f nj k 5l cg dq nd s4 xg xh co dr k ds 7g o 4 5l 7h 7i e 7j 9 7k r b 7l 7m 6y 9 7i 7n 7o 7p"
  },
  {
    "id": "janestreet-8448713002",
    "site": "janestreet",
    "title": "Campus Recruiter, Early Careers Partnerships & Initiatives",
    "companyName": "Jane Street",
    "jobUrl": "https://www.janestreet.com/join-jane-street/apply/8448713002?gh_jid=8448713002",
    "location": {
      "city": "New York",
      "state": "NY",
      "country": "United States",
      "text": "New York, New York, United States"
    },
    "locations": [
      {
        "city": "New York",
        "state": "NY",
        "country": "United States",
        "text": "New York, New York, United States"
      }
    ],
    "isRemote": false,
    "employmentType": "Full-Time: Experienced",
    "datePosted": "2026-03-04",
    "department": "Recruiting",
    "atsType": "greenhouse",
    "description": "0 1 2 3 8t 5 6 5l ti za e 9b 10n 10o 9 a b 10p 1 1w e 10q 1u 5l 10r 1u xi 7h ey 9 10s xl xm e 7x 7y 89 t wh fp r1 1 o9 oa p 7c 7w uk oc eu r 10t e rq 10u 10v uw ch ot e b8 10w 0 g tt 9 d 21 10x u4 21 36 10y 4j g 1b 10z 7n ey 110 1m dw 2r b0 1u g 9m h xi 7h 1m g 110 1m 2r 5l lm lv br e 111 9c x 112 g l m 10j 10k e 8n 8o i 1 110 1m 113 5l aa 10r 1u q 5n e e9 7n t rm 114 e 115 1w e 116 7h y6 a6 9 z8 y8 1f e 3f l ey 1a 1 117 kt 1 ie 1u 21 36 p jb j 4j c6 118 e 119 fq o b6 mk 9 11a 11b 9q ti cz e ww 4j 10q 4j hw hx 2q o hy 87 11c 5l l 1l 3w 2g 2h 11d e 11e 1 11f 9 11g 7v 6n a2 27 gx 9 z4 3d jj e 11h 11i 6 7 11j l8 11k 1u 21 11l k 5l 11m g 2v q ct 1a 11n 11o r lk hp e 3r t 1 8z 21 p 22 xu 6f 9 wk bv 6k 7z 80 le 1 11p 3o by 5s g 7h 1m 7w q7 3 yq x 10 11 3w yr ys 8t 1 m4 4h e6 b 3 wj 7u 3 2t e 11q bf 11r 3 wj 8a 3 q r 21 11s 11t g bt 6 xw hp 3r 7w 10 11 xk e vl lb yv 1u 2u cx 0 o 30 wv 5d 1u xi 7h 4f 5m 1u 1 11u 6n 11v 7h rv 2r 5l h6 fq d9 5l 11w 11x 9u 6e 5b 9 99 e 77 g xi 7h xp e 63 9 11y e kl 1c 4j 5l uy 9 2o b nu r 5l zh ly e 11z 9 25 120 d6 0 7u o c0 e d7 d8 c0 d9 da 9 db dc e dd de 5g 1m lx 63 9 q gf 121 e t ea 3r e 122 85 123 lm g2 r m3 g4 9 5y e 5l oz zk zl vz di m1 g8 gi r m3 1l e 124 dz 5i e 1 lh 9 125 25 1f 9b l8 126 b7 0 h zo 9 127 e 128 y6 5t 0 1 e2 1u 1 8z e z 7h 3i 27 1 zn yi zo 9 7h zp e y6 p 87 p1 6 21 2 7g o 4 5l 7h 7i e 7j 9 7k r b 7l 7m 6y 9 7i 7n 7o 7p"
  },
  {
    "id": "janestreet-8429265002",
    "site": "janestreet",
    "title": "China Business Development",
    "companyName": "Jane Street",
    "jobUrl": "https://www.janestreet.com/join-jane-street/apply/8429265002?gh_jid=8429265002",
    "location": {
      "city": "Hong Kong",
      "country": "Hong Kong SAR China",
      "text": "Hong Kong, Hong Kong"
    },
    "locations": [
      {
        "city": "Hong Kong",
        "country": "Hong Kong SAR China",
        "text": "Hong Kong, Hong Kong"
      }
    ],
    "isRemote": false,
    "employmentType": "Full-Time: Experienced",
    "datePosted": "2026-03-04",
    "department": "Sales & Trading",
    "atsType": "greenhouse",
    "description": "0 1 2 3 8t 5 6 7 pl e fy k3 fp an 3y r r4 5m 1u 1 k3 r5 4h 1a g 8n 8o 8p o p 129 85 5l 12a 12b 9 g 15 3z e 12c 7 lg 36 k xw g 1m k9 g 12d 12e eu j1 12f g 12g e y 1 8z 4j 12h 2h ti ey 9 3t 1 12i 1u g 12j e hh eu o 13 q 14 r s t 1 8z 9 12k g eu r 12d kx 40 12l v7 r5 12m e hp 44 12n 21 2r 5l m4 xn 36 x 12o 12p 4j 5n e e9 eu o 13 87 12q 9 zo e 8m 12r e 12s 1 8z 12t 9 ea 3z 34 35 1u 21 36 p 37 12u g 12d 12v e 10q 12w k k3 4h r g 12x bd hc e 12v 3r 9 3t 3 30 12y us r 1 12z 130 e 5l am a9 1u r5 131 5n eu 12d 9 3t 3 8t 132 9 133 9 r5 e hq ix 3 q k 5l lm br cl e 21 36 2r 5l 134 9 135 121 g fp an 1m 7w 1 136 1u ew o6 40 dx e 12e dz hh tt e 137 8l 81 az 138 e 139 r0 x p a b 18 e f g tt 6 1 13a 0 o 30 fl 5d 1u 4f r 5l 12e 6n 13b 13c 8z ul k 5l 13d 10q 12v 6n e1 xn 36 30 5l 12y a9 1u 1 13e 1u 1 k3 r5 zf r 5g 1l dz 5i 5y 13f e 63 9 ge 25 1f p5 4h r m4 e 6a 6u gf r ea 13g ln 6a b8 13h e 24 2x 27 zg yl lw e 13i of 9 zo 13j 9 1p r kx 12d 5g ju e jn jo dr k 13k e ds 7g o 4 5l 7h 7i e 7j 9 7k r b 7l 7m 6y 9 7i 7n 7o 7p"
  },
  {
    "id": "janestreet-8345570002",
    "site": "janestreet",
    "title": "Campus Recruiter, Technology",
    "companyName": "Jane Street",
    "jobUrl": "https://www.janestreet.com/join-jane-street/apply/8345570002?gh_jid=8345570002",
    "location": {
      "city": "New York",
      "state": "NY",
      "country": "United States",
      "text": "New York, New York, United States"
    },
    "locations": [
      {
        "city": "New York",
        "state": "NY",
        "country": "United States",
        "text": "New York, New York, United States"
      }
    ],
    "isRemote": false,
    "employmentType": "Full-Time: Experienced",
    "datePosted": "2026-01-13",
    "department": "Recruiting",
    "atsType": "greenhouse",
    "description": "0 1 2 3 8t 5 6 7 fy xj 9 a b xk e vl xl xm 9 8m g n7 n1 3r 7w 10 11 3 4 xn 4j dv e xo g 7h xp e 1 oa rv 2r bf qa 6h xq c6 4b p 87 eg 85 3 q 9 li xr 1u 1 xs 3 4 5 6 dj 8a 6a k9 2u cx u4 7z 80 mx xt 2x 9 g mj e 3e 21 p 22 xu 6f 9 wk bv 6k 7z 80 le 1 2q 9 2q 3o by l2 1 xi 7h 13l o 13 2o 27 1 13m r 5l cg hu u4 1u 7x no oa dz 1 4u e 56 13n l2 lk 13l p 13o c6 13p 4j 5b 3 6a 13q g mj g 1m y7 5l 2g ii 1u y8 lb y9 e ya 66 9 2u 7x ch e 3 qg 13r 1u 7y yc g l yd 1 ye e yf 1u 7h 7w 10 11 21 e7 5l 5x l3 fd x yg 5l r4 yh 27 g wk yi tt e z 7v yj 9 g en q 69 7y 3 p yk 9 y c6 yl u6 r ww 4j r9 e ym g 7h 1m 2r 7 yn yo yp 1m 1u m4 8a yq 10 11 3w yr ys 8t 1 m4 4h e6 b 3 wj 7u 3 2t e 8a 3 q r e 21 yt g bt 6 yu 6z 7w 1 8z r lb yv 1u 2u cx k 1 yw 13s 5d 3 30 ai 5l yy e v6 qe e s9 fd 9 xk 13t yz z0 1u 1 z1 yd 1a fk z2 1u 1 8d e 3 13 z3 4j c6 70 e r0 9 a z4 g tt z5 0 o 13u 5d 1u yl 7h 4f 13v 121 z6 11v 7h gy 9 al l 5i e 1n 7 z8 z9 4i za r 5l r4 a9 1u 1 oa rv 63 9 a b zb j7 3 8f 9 zc zd 9 xk lb yd g8 gi 8a 6a lo ka li g2 e 24 2x 27 zg zh 1m lx r 5l zi kt c6 zj oz zk zl vz di 63 9 6u 6v r s ot e 15 3z zm e d6 0 7u o c0 e d7 d8 c0 d9 da 9 db 6 a cs jt 5t 0 1 e2 1u 1 8z e z 7h 3i 27 1 zn yi of e b7 9 zo 9 7h zp e y6 85 jt oz 6c z7 4f p1 7g o 4 5l 7h 7i e 7j 9 7k r b 7l 7m 6y 9 7i 7n 7o 7p"
  },
  {
    "id": "janestreet-8209005002",
    "site": "janestreet",
    "title": "China Sales",
    "companyName": "Jane Street",
    "jobUrl": "https://www.janestreet.com/join-jane-street/apply/8209005002?gh_jid=8209005002",
    "location": {
      "city": "Hong Kong",
      "country": "Hong Kong SAR China",
      "text": "Hong Kong, Hong Kong"
    },
    "locations": [
      {
        "city": "Hong Kong",
        "country": "Hong Kong SAR China",
        "text": "Hong Kong, Hong Kong"
      }
    ],
    "isRemote": false,
    "employmentType": "Full-Time: Experienced",
    "datePosted": "2025-12-05",
    "department": "Sales & Trading",
    "atsType": "greenhouse",
    "description": "0 1 2 3 8t 5 9 vl 7 pl e fy 13w 3y xn 4j 1 k3 r5 j k 8n 8o 21 13x 9 g 1m p 87 5l 12a 12b 9 g 13y 13z e 12c 5l 140 36 k xw g 1m 11y 5l tt 6 1 13a o 13 q 14 r s t 1 8z 9 12k g 141 142 e 77 g 141 143 3 13 144 4j c6 r4 5m 1u 1 k3 r5 e 1 z7 85 3 145 ch 13y 13z e 6u g 7x 10r 1u fw e fx 9 66 21 2r 5l m4 xn 36 x 12o 12p 4j 5n e e9 eu o 13 87 12q 9 zo e 8m 141 12r 146 uw 13z e 147 4j 2u 148 149 e hh 14a e 12s 1 8z 12t 9 ea 3z 3 4 5 6 dj 8a y7 5l r4 a9 1u 13w e 6n 13w hh 85 95 85 sa 5m k 6c fx ca 85 14b 14c 6n 14d 14e 3 13 8f dj 8a 2r 63 9 ht 14f 1 13e 1u g fp 85 o 13 87 1 14g w4 14h r 13y 13z cs 123 k 13x 9 4h 14 r 1 ay 1u g 13y 1m o 13 q r g hh 1m 85 95 85 o6 ca 85 14i tt e 8l 9 u8 138 e 14j 11y 10 11 3w 14k 9 g k1 141 14l 0 o fl 5d 1u fm 4f k 13w 6n 13w hh k i3 i4 14m eb 5g a9 1u 1 13e 1u 1 14n r5 5m k 14o e 6n 14p 2r 5l h6 g2 e yl r 5l 5g g4 9 5y 63 9 6u 14q e 14r 14s c6 14t r2 4j c6 14u 6a b8 13h e 24 2x 27 zg 63 9 ge 25 1f ln lw e 13i r 5g gj 5i p8 k ds e 14v 13k 14n p1 7g o 4 5l 7h 7i e 7j 9 7k r b 7l 7m 6y 9 7i 7n 7o 7p"
  },
  {
    "id": "janestreet-8233259002",
    "site": "janestreet",
    "title": "ASIC Engineer",
    "companyName": "Jane Street",
    "jobUrl": "https://www.janestreet.com/join-jane-street/apply/8233259002?gh_jid=8233259002",
    "location": {
      "city": "London",
      "state": "England",
      "country": "United Kingdom"
    },
    "locations": [
      {
        "city": "London",
        "state": "England",
        "country": "United Kingdom"
      }
    ],
    "isRemote": false,
    "employmentType": "Full-Time: Experienced",
    "datePosted": "2025-10-29",
    "department": "Software Engineering",
    "atsType": "greenhouse",
    "description": "0 1 2 3 8t 5 9 vl 7 fy vm ak 9 a b c 3h e vq vr t6 59 85 b0 1u g vs om vt 1m o 13 30 1 2s 9 vu r m4 k r1 t 1 8z 40 hh vv e pr m9 3 8t 5 6 dj 8a 6a 14w 9 fk 1u g 19 e 87 kd 9 q 4j uf 14x j e vm j 14y 3 4 wk wl k 1 lh 1u 72 9 77 1 wm wn e 2q 9 2q wo 1u t6 n1 x 3w wp 3 wq wr 5l t6 an ou ws k nc 3 d7 d8 mk o 9 c0 nc 3 13 ke o bh fq 3 8t 5 6 t6 8s 8a 8t b7 0 1 wt x au 72 6a b2 e 8t of 9 qn l 2z 85 5l wu 0 o 14z 5d 1u 28 4f k vp c e x3 r 5l 150 e4 4j vm c x3 4f 151 vm 59 mc wa 152 6n 153 72 4f 55 n7 n1 qf 9 77 1 t6 c fd e nj k cg dq p0 ca 85 s4 xg 154 6n xh 34 7d 4f k hw 1u 1 155 156 x3 8w ic vp c e 157 6n j2 ic vn c dr k ds 7g o 4 5l 7h 7i e 7j 9 7k r b 7l 7m 6y 9 7i 7n 7o 7p"
  },
  {
    "id": "janestreet-8213653002",
    "site": "janestreet",
    "title": "ASIC Engineer",
    "companyName": "Jane Street",
    "jobUrl": "https://www.janestreet.com/join-jane-street/apply/8213653002?gh_jid=8213653002",
    "location": {
      "city": "New York",
      "state": "NY",
      "country": "United States",
      "text": "New York, New York, United States"
    },
    "locations": [
      {
        "city": "New York",
        "state": "NY",
        "country": "United States",
        "text": "New York, New York, United States"
      }
    ],
    "isRemote": false,
    "employmentType": "Full-Time: Experienced",
    "datePosted": "2025-10-29",
    "department": "Software Engineering",
    "atsType": "greenhouse",
    "description": "0 1 2 3 8t 5 9 vl 7 fy vm ak 9 a b c 3h e vq vr t6 59 85 b0 1u g vs om vt 1m o 13 30 1 2s 9 vu r m4 k r1 t 1 8z 40 hh vv e pr m9 3 8t 5 6 dj 8a 6a 14w 9 fk 1u g 19 e 87 kd 9 q 4j uf 14x j e vm j 14y 3 4 wk wl k 1 lh 1u 72 9 77 1 wm wn e 2q 9 2q wo 1u t6 n1 x 3w wp 3 wq wr 5l t6 an ou ws k nc 3 d7 d8 mk o 9 c0 nc 3 13 ke o bh fq 3 8t 5 6 t6 8s 8a 8t b7 0 1 wt x au 72 6a b2 e 8t of 9 qn l 2z 85 5l wu 0 o 14z 5d 1u 28 4f k vp c e x3 r 5l 150 e4 4j vm c x3 4f 151 vm 59 mc wa 152 6n 153 72 4f 55 n7 n1 qf 9 77 1 t6 c fd e nj k cg dq p0 ca 85 s4 xg 154 6n xh 34 7d 4f k hw 1u 1 155 156 x3 8w ic vp c e 157 6n j2 ic vn c 7g o 4 5l 7h 7i e 7j 9 7k r b 7l 7m 6y 9 7i 7n 7o 7p"
  },
  {
    "id": "janestreet-8229056002",
    "site": "janestreet",
    "title": "Campus Recruiter, Machine Learning and Quantitative Research",
    "companyName": "Jane Street",
    "jobUrl": "https://www.janestreet.com/join-jane-street/apply/8229056002?gh_jid=8229056002",
    "location": {
      "city": "New York",
      "state": "NY",
      "country": "United States",
      "text": "New York, New York, United States"
    },
    "locations": [
      {
        "city": "New York",
        "state": "NY",
        "country": "United States",
        "text": "New York, New York, United States"
      }
    ],
    "isRemote": false,
    "employmentType": "Full-Time: Experienced",
    "datePosted": "2025-10-27",
    "department": "Recruiting",
    "atsType": "greenhouse",
    "description": "0 1 2 3 8t 5 9 vl 5l xi xj 9 a b 11y tt e 99 g 7h xp 85 3 145 s9 e vl xm e l 158 6 uf g pr e pa cj pr 3r o p a b uy 159 e 15a g 8r 15b 6 uf 3r k g l m 8p y8 1 by m4 2r un 1u 1 t8 lg v5 1u g fp 3 30 ai 5l yy y5 tt e v6 s9 fd 9 xk e vl sa 1u 1 2v e 15c l 10x 1a fk z2 1u 1 8d fq g xi y5 xp 8t dv gg e 3 8f 34 ti 15d 9 a b li xr 1u 1 xs 3 8t 5 6 dj 8a 6a 15e m3 2q 9 2q oa dz 7z 80 15f 6y r ms 1u 7h e 3r t 10 11 9 b8 0 7u 3 6a 87 mw au e j7 g 7h xp 8f 9 zc zd g lh 9 2o 1 11p 2z by li 15g e 15h e 15i 15j r g ot 2r 7u yt g 7h 15k o 13 8f 9 87 lm g2 r m3 g4 9 5y e 5l zi kt c6 zj oz zk zl vz di c6 lh 9 2a 15l r 15m 15n 6 ot p 1n o 5l 15o 13x 9 fk 15p 1u 1 1m 0 o 30 wv 5d 1u yl 7h 4f lp 4f 3x 5l 15q 8r bg 2r 15r 7d gy 9 al l 5i e 1n 7 z8 z9 63 9 6u 6v r s ot e qe 15s zm e d6 0 7u o 2t e d7 d8 c0 d9 da 9 db 6 a e dd de g8 gi 8a 6a k9 ew 19 e 1f 15t 5t 0 1 e2 1u 1 8z e z 7h 3i 27 1 zn yi oz 6c z7 4f 2r p1 7g o 4 5l 7h 7i e 7j 9 7k r b 7l 7m 6y 9 7i 7n 7o 7p"
  },
  {
    "id": "janestreet-8151903002",
    "site": "janestreet",
    "title": "Campus Recruiter, Early Careers Partnerships & Initiatives ",
    "companyName": "Jane Street",
    "jobUrl": "https://www.janestreet.com/join-jane-street/apply/8151903002?gh_jid=8151903002",
    "location": {
      "city": "Hong Kong",
      "country": "Hong Kong SAR China",
      "text": "Hong Kong, Hong Kong"
    },
    "locations": [
      {
        "city": "Hong Kong",
        "country": "Hong Kong SAR China",
        "text": "Hong Kong, Hong Kong"
      }
    ],
    "isRemote": false,
    "employmentType": "Full-Time: Experienced",
    "datePosted": "2025-09-04",
    "department": "Recruiting",
    "atsType": "greenhouse",
    "description": "0 1 2 3 8t 5 6 5l ti za e 9b 10n 10o 8a 6a a b 10p 1 1w e 10q 1u 5l 10r 1u xi 7h ey 9 10s xl xm e 7x 7y 89 t wh 15u e fp r1 1 o9 oa p 7c 7w uk e e9 oc 7n r 10t bl 15v e rq 15w 15x 1 13a 7z 10v v6 ch ot e cz 10w 0 g tt 9 d 21 u4 1u 10x xi 7h 4f 2r p1 7z 5m 1u 1 7h rv t 1 k1 13a ox 87 o9 fq 2r d9 5l 11w g 1m y7 5l 2g ii 1u y8 lb y9 e ya 66 9 2u 7x ch e 3 qg 5l yb 1u 7y yc g l yd 1 ye e yf 1u 7h 7w 10 11 21 e7 5l 5x l3 fd x yg 5l r4 yh 27 g wk yi tt e z 7v yj 9 g en q 69 7y 3 p yk 9 y c6 yl u6 r ww 4j r9 e ym 9 15y c6 2q 9 2q p xz 1w e 116 ea gq 1u 7h y6 gr gs 4j xi 15z e k 8p 5n e e9 eu r 10t e 15 3z e l4 r 160 ot 3 p z3 4j c6 70 k l8 161 e 10n dz 9 b2 xt 2x 9 g mj e 9 a b zb j7 e z 3 8f 9 uw 9 xk 1 zd 162 1u lz 10x 21 p 22 xu 6f 9 wk bv 6k 7z 80 le 1 11p 3o by 21 36 10y 4j g 1b 10z 7n ey 110 1m dw 2r b0 1u g 9m h xi 7h 1m g 110 1m 2r 5l lm lv br e 111 9c 1u m4 x 112 t g l m 10j 10k e 8n 8o i 5s g 7h 1m 7w q7 3 yq x 10 11 3w yr ys 8t 1 m4 4h e6 b 3 wj 7u 3 2t e 11q bf 11r 3 wj 8a 3 q r 21 11s 11t g bt 6 xw hp 3r 7w 10 11 xk e vl lb yv 1u 2u cx 21 14g b6 mk 9 qg 1 163 164 165 k g l m 166 8p 33 167 9 8n 8o 0 o 30 164 5d 1u xi 7h 4f 6c fw z7 4f ox 87 oy fq d9 p1 13v 168 0 1 7h rv t k1 fq d9 p1 d6 0 7u o c0 e d7 d8 c0 d9 da 9 db dc e dd de 5g 1m lx 63 9 q gf 121 e t ea 3r e 122 85 123 lm zf r m3 g4 9 5y e 5l oz zk zl vz di m1 g8 gi 8a 6a k9 25 1f gf m3 1l e 124 dz 5i 9b l8 126 b7 0 h zo 9 127 e 128 y6 5t 0 1 e2 1u 1 8z e z 7h 3i 27 1 zn yi p8 k ds p1 zq zr nd ox 87 5l h6 fq d9 p1 7g o 4 5l 7h 7i e 7j 9 7k r b 7l 7m 6y 9 7i 7n 7o 7p"
  },
  {
    "id": "janestreet-7998232002",
    "site": "janestreet",
    "title": "Cybersecurity Engineer - Threat Modelling",
    "companyName": "Jane Street",
    "jobUrl": "https://www.janestreet.com/join-jane-street/apply/7998232002?gh_jid=7998232002",
    "location": {
      "city": "Hong Kong",
      "country": "Hong Kong SAR China",
      "text": "Hong Kong, Hong Kong"
    },
    "locations": [
      {
        "city": "Hong Kong",
        "country": "Hong Kong SAR China",
        "text": "Hong Kong, Hong Kong"
      }
    ],
    "isRemote": false,
    "employmentType": "Full-Time: Experienced",
    "datePosted": "2025-05-15",
    "department": "Cybersecurity",
    "atsType": "greenhouse",
    "description": "0 1 2 3 4 5 6 5l ww 4j 8q ak 9 8m g 8q 1m 9 169 1 8k 16a 1u g 16b gx m9 e 3e 1 36 16c uf ww 4j 5h 70 9 16d e 16e 16f e m4 5i 9 7k r ea 3r t 1 8z 16g 3r 9 16h 1 8k 16i 1u c 50 e 16g 66 9 d 8k 27 2u 16b 1a 1 117 kt 1 36 p 16j c6 ww 4j 16k 16l 9 145 91 e 22 o 9 yh r4 27 1 5h 3o e a d 16m 8k 6f e 11y 4i qs 9 td q6 21 36 p 22 28 cq cr 5i e 1 lh 9 k0 8k 16n 27 16o 7e 16p 1 36 80 nn lp 16q r ef 16r 8a jx 2u 16b fq 16s d9 16t ch 16u ev r 66 9 145 e a 16v 16f e 16w mi 9q 8k du e fp 26 85 5l ll 1u 1 8q 1m o 13 8m 5l 9b 9c 1u 9d e 8k 9e 9f 9 9g 1 8z 9h g q 16x 5l aa 10r 1u 16y 1a n7 n1 e 16z 9 bd x5 8k fs e 90 zv 0 o 16k 8k 16l 6a a d e s2 170 6f 1a 1 117 kt tc 5z 171 10a td 6k 4j 5l 172 e 60 5l ww 4j mj 9 df bu e 173 9b 7w id 8k mi e jj bd j 50 7 m3 jo 8a 174 4j 175 9 m4 e 5n eu 5l br ly 2r 5l 176 lh 9 ke 6z e 177 5m 0 cq cr 5g on 16l o c0 c6 178 e6 5l 179 e 8t 17a k c6 101 lh 5z 60 17b e 63 9 f9 c6 3d jj 17c 78 k hw nj nd 2r 5l h6 dr k ds 7g o 4 5l 7h 7i e 7j 9 7k r b 7l 7m 6y 9 7i 7n 7o 7p"
  },
  {
    "id": "janestreet-7988179002",
    "site": "janestreet",
    "title": "Cybersecurity Engineer - Threat Modelling",
    "companyName": "Jane Street",
    "jobUrl": "https://www.janestreet.com/join-jane-street/apply/7988179002?gh_jid=7988179002",
    "location": {
      "city": "London",
      "state": "England",
      "country": "United Kingdom"
    },
    "locations": [
      {
        "city": "London",
        "state": "England",
        "country": "United Kingdom"
      }
    ],
    "isRemote": false,
    "employmentType": "Full-Time: Experienced",
    "datePosted": "2025-05-13",
    "department": "Cybersecurity",
    "atsType": "greenhouse",
    "description": "0 1 2 3 4 5 6 5l ww 4j 8q ak 9 8m g 8q 1m 9 169 1 8k 16a 1u g 16b gx m9 e 3e 1 36 16c uf ww 4j 5h 70 9 16d e 16e 16f e m4 5i 9 7k r ea 3r t 1 8z 16g 3r 9 16h 1 8k 16i 1u c 50 e 16g 66 9 d 8k 27 2u 16b 1a 1 117 kt 1 36 p 16j c6 ww 4j 16k 16l 9 145 91 e 22 o 9 yh r4 27 1 5h 3o e a d 16m 8k 6f e 11y 4i qs 9 td q6 21 36 p 22 28 cq cr 5i e 1 lh 9 k0 8k 16n 27 16o 7e 16p 1 36 80 nn lp 16q r ef 16r 8a jx 2u 16b fq 16s d9 16t ch 16u ev r 66 9 145 e a 16v 16f e 16w mi 9q 8k du e fp 26 85 5l ll 1u 1 8q 1m o 13 8m 5l 9b 9c 1u 9d e 8k 9e 9f 9 9g 1 8z 9h g q 16x 5l aa 10r 1u 16y 1a n7 n1 e 16z 9 bd x5 8k fs e 90 zv 0 o 16k 8k 16l 6a a d e s2 170 6f 1a 1 117 kt tc 5z 171 10a td 6k 4j 5l 172 e 60 5l ww 4j mj 9 df bu e 173 9b 7w id 8k mi e jj bd j 50 7 m3 jo 8a 174 4j 175 9 m4 e 5n eu 5l br ly 2r 5l 176 lh 9 ke 6z e 177 5m 0 cq cr 5g on 16l o c0 c6 178 e6 5l 179 e 8t 17a k c6 101 lh 5z 60 17b e 63 9 f9 c6 3d jj 17c 78 k hw nj nd 2r 5l h6 p8 k ds p1"
  },
  {
    "id": "janestreet-7642974002",
    "site": "janestreet",
    "title": "Cybersecurity Engineer - Detection and Response",
    "companyName": "Jane Street",
    "jobUrl": "https://www.janestreet.com/join-jane-street/apply/7642974002?gh_jid=7642974002",
    "location": {
      "country": "Singapore"
    },
    "locations": [
      {
        "country": "Singapore"
      }
    ],
    "isRemote": false,
    "employmentType": "Full-Time: Experienced",
    "datePosted": "2024-09-23",
    "department": "Cybersecurity",
    "atsType": "greenhouse",
    "description": "0 1 2 3 4 5 9 m7 5l 8g 8q ak 9 g 8n 8o 6n 10k 8p 9 a m8 10 11 3w 89 gx e m9 1a 1 ma 1u 1 mb g 8q 8s 8t 8u 6 3f e mc iw 72 9 md 1 8z 85 95 85 it 93 94 e me cs 5l cq 2r mf g 1m 17d 17e 9 87 9k 27 1 9l 17f 121 1 9m 8q 9n e 63 9 9o 1 9p 9q 1 9r 9s 9t 9u 8k 9v e 7u 8e 9w k g 2q 9 2q k 21 36 o 13 mg 9i 1 mh 1u g 50 85 3 b8 0 1 b9 ba 3 4 jj k g mj 9 52 8q 54 3 13 mk o 9 ml 5l mm mj 9 mn mo 92 9 mp e mq 1 aj 1u 5l 8k mr 7z nu p 87 7 17g 1u 6d 142 c6 7y p 80 87 w6 4j 19 9 77 g 17h 9a 96 e 17i 85 95 85 mn cq 17j 17k o 9 99 c6 17l 1e e z9 o p 80 8b 85 7 ax 1u 2v ao 9 1 ay 1u 1 8z fk 1u g 1m ms jx e 17m am c7 8q mt e 8t 63 9 mu 9 6z 0 7v 5l az mv 1u mw 95 k 21 2 2r mx b3 my b4 r o 4j 1 8q b5 e o b6 87 b7 9 al 1a c6 s e mz x cj 4j 9 l 8s 0 o fn 3w fo k c3 c4 n1 6p ae 6n je 4f 7d 7 n2 n3 1u 8q n4 5l 5g 17n o b6 87 63 9 w2 17o x 8t 17p 17q e 17r 87 17s 27 um af mc 5l 17t 17u nj nd 5z e 8j k 3x c6 aq e n5 k cm cn e 30 5l 4h 5m 1u c6 ck 3 d7 d8 go dw n6 cp r cq 17v e 63 9 6v 6u c6 a9 1u 1 b9 ba 3 4 jj 9 3q g1 63 9 cv 1 8q 50 o bi cw k c6 cx c8 e z o bi cy cz 0 d0 50 63 9 d1 9 6o d2 e 1n d3 50 d4 d5 d6 di 0 7u o c0 e d7 d8 c0 d9 da 9 db dc e dd de 5t df dg r 5l dh br di nj 4f 2r 5l h6 dr k ds 7g o 4 5l 7h 7i e 7j 9 7k r b 7l 7m 6y 9 7i 7n 7o 7p"
  },
  {
    "id": "janestreet-7642886002",
    "site": "janestreet",
    "title": "Cybersecurity Engineer - Detection and Response",
    "companyName": "Jane Street",
    "jobUrl": "https://www.janestreet.com/join-jane-street/apply/7642886002?gh_jid=7642886002",
    "location": {
      "city": "Hong Kong",
      "country": "Hong Kong SAR China",
      "text": "Hong Kong, Hong Kong"
    },
    "locations": [
      {
        "city": "Hong Kong",
        "country": "Hong Kong SAR China",
        "text": "Hong Kong, Hong Kong"
      }
    ],
    "isRemote": false,
    "employmentType": "Full-Time: Experienced",
    "datePosted": "2024-09-17",
    "department": "Cybersecurity",
    "atsType": "greenhouse",
    "description": "0 1 2 3 4 5 9 m7 5l 8g 8q ak 9 g 8n 8o 6n 10k 8p 9 a m8 10 11 3w 89 gx e m9 1a 1 ma 1u 1 mb g 8q 8s 8t 8u 6 3f e mc iw 72 9 md 1 8z 85 95 85 it 93 94 e me cs 5l cq 2r mf g 1m 17d 17e 9 87 9k 27 1 9l 17f 121 1 9m 8q 9n e 63 9 9o 1 9p 9q 1 9r 9s 9t 9u 8k 9v e 7u 8e 9w k g 2q 9 2q k 21 36 o 13 mg 9i 1 mh 1u g 50 85 3 b8 0 1 b9 ba 3 4 jj k g mj 9 52 8q 54 3 13 mk o 9 ml 5l mm mj 9 mn mo 92 9 mp e mq 1 aj 1u 5l 8k mr 7z nu p 87 7 17g 1u 6d 142 c6 7y p 80 87 w6 4j 19 9 77 g 17h 9a 96 e 17i 85 95 85 mn cq 17j 17k o 9 99 c6 17l 1e e z9 o p 80 8b 85 7 ax 1u 2v ao 9 1 ay 1u 1 8z fk 1u g 1m ms jx e 17m am c7 8q mt e 8t 63 9 mu 9 6z 0 7v 5l az mv 1u mw 95 k 21 2 2r mx b3 my b4 r o 4j 1 8q b5 e o b6 87 b7 9 al 1a c6 s e mz x cj 4j 9 l 8s 0 o fn 3w fo k c3 c4 n1 6p ae 6n je 4f 7d 7 n2 n3 1u 8q n4 5l 5g 17n o b6 87 63 9 w2 17o x 8t 17p 17q e 17r 87 17s 27 um af mc 5l 17t 17u nj nd 5z e 8j k 3x c6 aq e n5 k cm cn e 30 5l 4h 5m 1u c6 ck 3 d7 d8 go dw n6 cp r cq 17v e 63 9 6v 6u c6 a9 1u 1 b9 ba 3 4 jj 9 3q g1 63 9 cv 1 8q 50 o bi cw k c6 cx c8 e z o bi cy cz 0 d0 50 63 9 d1 9 6o d2 e 1n d3 50 d4 d5 d6 di 0 7u o c0 e d7 d8 c0 d9 da 9 db dc e dd de 5t df dg r 5l dh br di nj 4f 2r 5l h6 dr k ds 7g o 4 5l 7h 7i e 7j 9 7k r b 7l 7m 6y 9 7i 7n 7o 7p"
  }
];
