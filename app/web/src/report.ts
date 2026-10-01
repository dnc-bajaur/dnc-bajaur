/**
 * The post-incident report, on a screen and on paper — capability group 9.
 *
 * `M1-06` built the report and `GET /incidents/:id/report` served it. **Nothing in the client
 * ever called it**, which is the same fault search and export shipped with: an endpoint with
 * no door is not a capability. An operator asked for a report had no way to get one.
 *
 * ## Why this is the PDF answer
 *
 * The scope list asks for PDF output. The boring way to produce a PDF from a web application
 * is **the browser's own print dialogue**, and on this project boring is the requirement, not
 * a compromise: ADR-0007 asks of every new dependency *"who restarts this when it fails, and
 * how do they know it failed?"* — and a PDF library is a rendering engine, a font stack, and a
 * layout implementation that will differ from the screen and drift from it. A print stylesheet
 * has none of those, works offline, needs no server round trip, and produces a document that
 * is by construction the same one the operator was just looking at.
 *
 * ## Nothing is retyped
 *
 * Every value here comes from the fold. That is M1-06's rule and it survives onto paper: if an
 * operator retypes what the system already knows, the retyped version becomes a second account
 * free to disagree with the first, and a review then has two documents and no record.
 */

interface Actor {
  seatTitle: string | null;
  personName: string | null;
}

interface Timing {
  label: string;
  at: string | null;
  minutesFromOccurrence: number | null;
  missing: string | null;
}

interface Entry {
  at: string;
  recordedLaterMinutes: number;
  what: string;
  by: Actor;
  detail: string | null;
  /** This line happened after the incident was resolved for good — tagged, not hidden. */
  afterResolution: boolean;
}

interface Recipient {
  /** Person first, then post (ADR-0035); one string when the two would restate each other. */
  name: string;
  delivery: 'delivered' | 'failed' | 'pending' | 'unknown';
  failure: string | null;
  response: string | null;
  respondedAt: string | null;
  /**
   * The saved group this recipient came from — Case 3, 2026-09-10. `null` for anybody ticked by
   * hand; the "Who was told" section heads its rows with it. Optional so an older server's
   * report still renders.
   */
  group?: string | null;
}

interface Report {
  incidentId: string;
  /** The district's own number — `DNC-BAJAUR-42`, 2026-08-24. Null until the sweep reaches it. */
  reference?: string | null;
  generatedAt: string;
  what: {
    category: string;
    severity: string;
    severityAssessed: boolean;
    severityOverriddenFrom: string | null;
    overrideReason: string | null;
  };
  who: { reportedBy: Actor; departments: string[]; acknowledgedBy: Actor | null };
  timings: Timing[];
  connectivity: { arrivalGapMinutes: number; lateArrival: boolean };
  unitsSent: { name: string; minutesCommitted: number | null }[];
  narrative: Entry[];
  recipients: Recipient[];
  /**
   * Who was coming, when this notice asked who is coming — the Case 2 (meeting) work,
   * 2026-09-10. Null for every emergency, a plain notice and `schedule`.
   */
  attendance?: {
    told: number;
    coming: number;
    answered: number;
    attending: number;
    sendingSomeone: number;
    notAttending: number;
    other: number;
    unanswered: number;
    closesAt: string | null;
  } | null;
  notifications: { attempted: number; delivered: number; failed: number; stillPending: number };
  escalations: number;
  evidence: { filename: string }[];
  outcome: string | null;
  closureNotes: string | null;
  gaps: { what: string; why: string }[];
}

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

/**
 * The Seal of the Deputy Commissioner, Bajaur — the mark on the district's WhatsApp number —
 * as a base64 JPEG. It rides **in** the document rather than as a linked asset for two reasons:
 * the report is a filed page and a broken image on a filed page is worse than none, and it is
 * an `<img>` rather than a CSS `background-image` so it prints even when the operator's browser
 * has "Background graphics" unticked (Chrome's default). ~27 KB, and this screen is in the lazy
 * `report.js` group — it costs the shell a field officer downloads nothing.
 */
const DC_SEAL =
  'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGh0dHx8fExciJCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh7/wAARCAEAAQADASIAAhEBAxEB/8QAHAABAQACAwEBAAAAAAAAAAAAAAIHCAEDBgUE/8QASRAAAgECAgMMBgYHBgcAAAAAAAECAwQFEQYHCBIhMUFGZoGEkaXD4xMiUWFxoRcYMnKUsRRSVaTB0dIVIyQzVLJCRWKCksLw/8QAGwEBAQADAQEBAAAAAAAAAAAAAAECBQcGAwT/xAA5EQACAAQCBggEBQQDAAAAAAAAAQIDBBEFBiExcaGy0RMWNUFRU2GBEhQy4UKCkaKxFSIj8FLB8f/aAAwDAQACEQMRAD8A3LAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB13NehbUJ17mtTo0oLOU6klGMV72zxeMa0tEsPlKFO6rX01xW9PNdryR+inpJ9Q7SoHFsQPcAxHda7bWM2rbR6tUjxOpdKD7FFnR9OHNj9/8ALNksvYi1fo98PMtmZjBht68ua/7/AOWcPXnzX/f/ACy9XcS8vfDzFmZlBhn6dOa3eHlnH0681u8PLHVzEvL3w8xZmZwYX+nbmt3h5Zw9e/NXvDyx1cxLy98PMWZmkGFfp55q94eWcfT1zU7w8svVzEvL3w8xZmawYTevvmp3h5Zx9PnNTvHyx1cxLy98PMWM2gwg9fvNPvHyjh6/+afePlDq3iXl74eYsZwBg57QHNLvHyjvtdf1nKaV1ozXpR43Tu1N9jjEjy5iSV+i3w8xYzUDHuB64dCsSlGFW7r4fOXFdU8l/wCSzR720ube8toXNpXpV6FRZwqU5qUZL2prhNbUUc+mdp0Dh2oh2gA/MAAAAAAAAAAAAAeN1g6fYdotTdtTUbvEpRzjQjLeh7HN8Xw4WNaemMNFsIVO2cJ4lcpqhF7+4XHNr3cXtZrpd3Fa6uKlxcVZVatSTlOcnm5N8bPT4FgXzf8Ann/R3Lx+xUj6mk2k2M6Q3Dq4pezqxzzjSW9Th8I//M+K2GyGzoEuVBKhUMCsl4GQbJbDZLZ9AGyWw2S2UBs4bDZDZQGyWw2S2AGyWw2S2UBshsNktlAbJbDZLKAzhsNktlAbPtaKaW4/ovdKvg9/UoxzznRl61Ofxi97+J8NshswmSoJsLgjV0/EG1uq/WZhemVNWdWMbHFoxzlbyl6tTLhcHx/DhXzPfGi9rc17S5p3NtVnRrUpKVOcHk4tcaNqdS+nsNMsElRvHCGLWcUriK3vSLgVRL38fsfQc8x/L/ya6eR9HevD7GLR78AHlCAAAAAAA67mvStrarc15qnSpQc5yfBGKWbZ2HiNd2JPD9A7inCW5nd1I0F8Hvv5Jn6KSQ6ifBKX4mkDBumeOVtIdIrrFKzluaksqUX/AMEF9ldnzzPithshs6/KlwyoFBCrJaDM5bIbDZLZ9AGyWw2S2UBs4bDZDZQGyWw2S2UBslsNktgBshsNktlAbJbDZJQDhsNktlAbJbDZDZQGyWw2S2UBs+3oHpHcaLaVWWM27luaU8q0E/t03vSj2fNI+E2S2YTJUM2BwRq6ehkN7rO5oXlnRu7WrGrQr041Kc48EotZproO0xxs54vLFNWttQqTcqlhVnbPPiS9aK7JIyOcYrKd01RHJf4W0YgAH5gAAADEe0jXlGxwW2T9WpUrTa98VFf+zMuGHNpb/kHWfCN1l5J4jLv68LKtZhxslsNktnUTINkthslsoDZw2GyGygNkthslsANkthslsoDZDYbJbKA2S2GyWUBnDYbJbKA2S2GyGygNkthslsoDZLYbJbKQNkNhslsoNhNki4lPD9IrVv1adWhUS98lNP8A2IzoYD2Q+VHVPGM+HJsyJLE5tvThRiwADRgAAAGG9pjk/wBZ8IzIYa2meT/WfCN3l3tKX78LKtZhpslsNktnUTINnDYbIbKA2S2GyWygNkthslsA4bJbPIa1dJK2j+AwVnUULy6m4UpcLil9qS+XaYOp4ridO+/T4X9yrrPdel9K9038TQYnmCVQTlJ+H4n36bWI3Y2ebJbPN6utIJ6Q6N07m4a/SqUnSr5cbXBLpWXzPRM3dPPgqJUM2DU1coZw2GyWz7gNkthshsoDZLYbJbKA2S2GyWykDZDYbJbKA2S2GyWwDP8Asg8qOqeMZ9MAbIHKjqnjGfzlGZu1JvtwoxYABoQAAADDO03yf6z4RmYwxtOcnus+EbvLnaUv34WVazDDZw2GyGzqRkGyWw2S2UBslsNktgHDZLYbPhadYx/YmjF5fRluaqhuKP35by/n0GE6bDJlxTItSVwYc1r4w8W0urxhPdULT+4prPezT9Z9ufYjyYk3KTlJttvNt8YOPVVRFUTopsWtu58zIWpDFo2uO18LqyyheU91T+/Hfy7M+wzG2ay4LfTw3FrW/p57qhVjPe40nvrsNlLetTuLenXpSUqdSCnFrgaazTPe5Tq+kpopL1wvc/vcyhZ2Nkthshs9WZBslsNktlAbJbDZLZSBshsNlKlVks40pte6LMJk2CWrxtLaZy5Ucx2ghb2HW2S2czUovKSafsaIbM4WoldGLThdmGyWw2S2ZENgNj7lT1TxjYA1+2POVPVPGNgTk+Zu1JvtwojAANCQAAAGF9p3k91nwjNBhbaf5PdZ8I3eXO0pfvwsq1mFmyWw2S2dTMg2S2TWqQpU5VKk4whFZylJ5JL2s8ldaxtEqFaVJ4lKbi8m4UZyXakfCdVSae3SxqG/i7C561shs8e9ZeiP+vq/h5/yJesrRL/X1fw8/wCR8P6pRedD+qJdHsGzDuvLGXcYnbYLSn/dW0fS1UuOb4M/gvzPX1dZWiipylC8rTkk2o+gms37OAwli19XxLE7m/uHnVr1HOXuz4vguA89mTFpMdMpMiNRfE9NnfQuZGz8p9nFtH7nD9HcMxernub3derl9lL7Pas2fn0awypjOOWmHU816aolKX6seGT7MzNWsHBKd/oVXs7eCUrSmqlBLi3C4OlZo8/hmEuspp0230rRt1/xo9yJGBDOGqPE3f6JU7ect1Us5Ok8/wBXhj8t7oMHnt9TmKuy0klYTllRvae5y/6478X2bpdJcuVfy9dCnqi0frq3iF6TM7Z+PFsRtMLsKl7fVlSo01vt8fsS9rP1NmL9d2J5zssIhLgTr1F8o/xOh4pW/I0sU7vWrazJux+mvrVs1UkqOEV5wz3pSrKLfRkzretWh+xav4hf0mLgc9eZsS/57lyMLsylT1p2jmlUwivGPG41k2ujJHtsIxK0xawp3tlV9JRnx5ZNPjTXEzXcypqYpXMMIvatRSVCpWXos+Npes18l0G8wDHauqquhnf3Jp9yVrbCpmT8Mtoyj6aos/1U/wAz6J02DTs6TX6p3HPMfrp1ZXzIpr1NpLwSdrc/U79l+hk0dBLhlLWk2/FtXvy9DqurencU3Ga3+J8aPPV4OlUlTlwxeR6Y89izTv6mXu/I9XkGunOfHSt3gtfY7pb7nlc/UMlSJdUlaO9tqs3usflbJbDZLZ1I5abBbHfKnqfjmwRr5sc8qup+ObBnJszdqTfy8KMWAAaEAAAAwrtQ8nes+EZqMKbUXJ3rXhG8y52lL9+FlWswo2S2GyWzqRkeI113F1Q0JmrZyUatxCnWa/Uab/NRXSYHNpMTs7bEbGrZXlKNWhVjuZwfGjHN3qisZV5StsZuKVNvehOiptdOa/I8fmDBaqrnqbJ0q1rXtb9TFoxCDK71Q0P29U/DL+ofRFR/btT8Mv6jQ9W8S8veuZPhZigGVvojo/t2p+GX9Rdvqms41oyr4zXqU0/WjCiot9Oby7CrLWIt/RvXMfCz82pDBn/iscrR3v8AIoZ9sn+S7TKE0pRcZLNNZNH58NsrXDbGlZWVJUqFJZRiuI7mzoOGUKoqaGT3rXt7zNKxrtpdhssI0jvbFrKMKrdP3we/H5NH4cOu6tjf0Lyi8qlGopx6GZE134bua1li0I7006FR+9b8f4mNDmeKUzoq2OCHRZ3WzWj5vQzZOxu6V7Y0byi86VamqkX7mszAWmGI/wBq6S3t6pZwlUcYfdW8vkj2Gj+k36PqwvaSqZXVs3Qp7++lP7L6PW7DHJucxYoquRIhh718T26uZWzusbed3e0bWkvXrTUI/FvIzDDV9o0oRUras5JLN+nlvvtPE6pcMV7pL+l1FnTs4Op8Zvej/F9BmBs/flfCpM2ninT4FFd6Lq+hff8AgJHl4aBaMwmpfodSWXFKtJr8z0VvRo21CFC3pRpUoLKMIrJJHY2S2evp6Onp7uVAob+CsZH7sNvVQzp1c9w+B+w+vCpTnHdQnGS9qZ5hsls8vjOTabEZznwRuCJ69F0/W11p9z2ODZyqcOkqRHAo4Vq02a9L2ej2Pv3uIUaEWoSU6nElwL4nn6k3OblJ5tvNs4bJbNtgeAU+ES2pemJ62/8AdCNVjeP1GLxpzNEK1Jf7pYbJbDJbN6aM2F2OOVXU/HNgzXrY35VdT8c2FOS5n7Um/l4UYsAA0IAAABhPak5O9a8IzYYS2puTnWvCN5lztKX78LKjCTZDYbJbOpmQbJbDZJQGcNhslsoDZLYbIbKA2S2GyWyg+LpzhyxXRe9tFFSqbj0lP3Sjvr8suk1/NmGzAOnGGLCdJ7y1hHKk5+kpfdlvpdHB0HiM4Un0VK2P+V/2YRHxlOahKCk1GTTaz3nlwfmcA7sPtp3l9QtKabnWqRpx+LeR4iFOJqFGJlvVPhrstGld1I5VLybqe/creX8X0nrmzqs6ELSzo21NZQpQUI/BLIts7NQ0qpaeCSu5f+7z6INkthsls/WA2S2GyWygNksMlsoDZLYbJbKDYbY15V9T8c2GNeNjPlX1PxzYc5JmftSb+XhRiwADQgAAAGENqfk51rwTN5g/ap5Oda8E3mW+0pfvwsqMINkthslnVDIM4bDZLZQGyWw2Q2UBslsNktlAbJbDZLZSBsxtrowxyo2mL04/Ybo1enfi/wA10oyO2fO0gw2ljGEXGH1nuY1Y5KSX2Xwp9pr8Vo/nKSOStbWjatRGa+HstUmHq60ileTjnC0puS+895fLM6K+r/SSnculTt6VWnnvVVWio5e3JvP5GRNCcAjo/hToSmqlxVlu601wZ8SXuX8zxGBYLUuthjnS3DDDp0rvWq3jpIkfebJbDZLZ0kyDZLYbJbKA2SwyWygNkthslsoDZLYbIbKDYnYy5WdT8c2INdtjDlZ1PxzYk5JmftSb+XhRiwADQAAAAGDtqvk31rwTOJhXaot5Sw/AbrL1adWvTb98lBr/AGM3eXGliUq/rwsqMDM4bDZLZ1YyDZLYbIbKA2S2GyWygNkthslspA2Q2GyWygNkthslsANkthslsoDZLYbJbKA2SwyWygNkthslsoDZDYbJbKA2S2GyWyg2L2LuVnU/HNijXzYwt5Rw3Sa8a9WrWt6afviqjf8AvRsGcizM08Um29OFGLAANCAAAAY92gsKliWrm5qwjup2VWFyvclvS+UmZCOq8t6N5aVrS5pxqUK0HTqQlwSi1k12H6aOodNPgnL8LTBo82S2fc080fuNF9KbzB66k40p50ptfbpvfjLs+aZ8Bs7LKmQzYFHA7p6TMNkthsls+oDZLYbJbKQNkNhslsoDZLYbJbADZLYbJbKA2S2GyWygNkthktlAbJbDZLZQGyGw2S2UBslsNktlAbJbDZ9/V1oxdaYaY2GBW0ZZVqmdaaX+XSW/KT9m982jCbMhlQOZG7JaWDabZewWWE6qrW4qQcKmI1p3TzXDF+rF9kUZSOmwtLewsaFjaUo0be3pxpUqceCMYrJJfBI7jiNbUuqqI5z/ABNsxAAPygAAAAAA8Drm0Dhplgiq2ahDFrRN28nvekXHTb9/F7H0mq17b3FndVbW6ozo16UnGdOaycWuJm854DWlqxwvTKm7yjKNji0I5RuIx9Wp7FNLh+PCj1eX8fVH/gn/AEdz8PsVM1PbJbPu6XaJY/otdu3xnD6lGOeUKy9anP3qS3v4nwGzosqZBNhUcDun3oobIbDZLZ9QGyWw2S2AGyWw2S2UBslsNktlAbJYbJbKA2S2GyWygNkthshsoDZLYbJbKA2S2Gz7+hehekumF6rbAsMq3C3WU6z9WlT98pPe6OEwmTYJULjmOyXewfDs7a4vbulaWlGpXuK0lCnThHOUm+BJG5GoPVtDQTR+VxfqnUxu+incyjv+ijwqkn7uP2v4IantUWD6CQV/cShiONzhlK5lH1aWfCqafB97hfu4DJhzbMWYlWr5en+jvfj9v5IAAeQIAAAAAAAAAAAAdV5bW15bVLW7t6VxQqLczp1YKUZL2NPeZj3H9S2g+KSlUoWlfDakt/O1qZRX/a80ZHB+mnrKimd5Mbh2MGC7vZ1tJTbtdKq9KPEqlkpvtU4n5/q5c8u7PNM+A2azJiaVul3Q8hcwE9nHnl3Z5pL2b+eXdnmmfwZdZsU83dDyLc1/+rdzz7s804+rbzz7r802BA6zYp5u6HkLmvr2bOendfmnH1a+endfmmwYHWbFPN3Q8iXNfHs1c9O6/NJ+rTz17r802FA6z4p5v7YeQua8vZn5691+acfVm57d1ecbDgdZ8U839sPIXNd3sy89u6vOOHsyc9+6vONiQXrPinm/th5C5rq9mLnv3V5x32mzJZRmnd6YXFWPGqVgqb7XORsGCPM+KPR0u6HkLmLdHNQ2r/CZRqXFncYrUi887yrnF/GMckzJljaWlhaU7SxtqNrb0luadKjBQhFexJbyO4Grqa2oqnedG4trAAB+UAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH/9k=';

/**
 * The district's official letterhead, above the report's own title — the Deputy Commissioner's
 * office, not just the software's name. A `<div>` and never a `<header>`: `report.css`'s print
 * rules hide every `header` element, and this one must print.
 */
function letterhead(): HTMLElement {
  const head = document.createElement('div');
  head.className = 'reportLetterhead';

  const govt = document.createElement('p');
  govt.className = 'reportLetterhead__govt';
  govt.textContent = 'Government of Khyber Pakhtunkhwa';

  const seal = document.createElement('img');
  seal.className = 'reportLetterhead__seal';
  seal.src = DC_SEAL;
  seal.alt = 'Seal of the Deputy Commissioner, Bajaur';
  seal.width = 74;
  seal.height = 74;

  const office = document.createElement('p');
  office.className = 'reportLetterhead__office';
  office.textContent = 'Office of the Deputy Commissioner';

  const district = document.createElement('p');
  district.className = 'reportLetterhead__district';
  district.textContent = 'District Bajaur';

  const rule = document.createElement('div');
  rule.className = 'reportLetterhead__rule';

  const system = document.createElement('p');
  system.className = 'reportLetterhead__system';
  system.textContent = 'District Nerve Center · DNC Bajaur';

  head.append(govt, seal, office, district, rule, system);
  return head;
}

/**
 * The person first, then the post — ADR-0035.
 *
 * ADR-0004 is untouched: the duty attaches to the post. This is the name a human reads on a
 * filed page, where the officer's name is what a DC office quotes back. When the two strings
 * would restate each other — a control-room seat whose holder's name is the seat's name — it
 * is printed once rather than as "X — X".
 */
function actorWords(actor: Actor | null): string {
  if (actor === null) return 'the system';
  const { seatTitle, personName } = actor;
  if (seatTitle === null && personName === null) return 'the system';
  if (personName === null) return seatTitle ?? 'an unnamed designation';
  if (seatTitle === null) return personName;
  return personName === seatTitle ? personName : `${personName} — ${seatTitle}`;
}

function when(iso: string | null): string {
  return iso === null ? '—' : new Date(iso).toLocaleString();
}

function section(heading: string): HTMLElement {
  const h = document.createElement('h3');
  h.textContent = heading;
  return h;
}

function pairs(rows: readonly (readonly [string, string])[]): HTMLElement {
  const dl = document.createElement('dl');
  dl.className = 'reportPairs';
  for (const [label, value] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    dl.append(dt, dd);
  }
  return dl;
}

export interface ReportPanel {
  show(incidentId: string): Promise<void>;
}

export function mountReport(): ReportPanel {
  const body = el('piReportBody');
  const error = el('piReportError');

  return {
    async show(incidentId: string): Promise<void> {
      error.hidden = true;
      body.replaceChildren(document.createTextNode('Folding the record…'));

      let report: Report;
      try {
        const res = await fetch(`/incidents/${incidentId}/report`, { cache: 'no-store' });
        if (!res.ok) {
          error.hidden = false;
          error.textContent =
            res.status === 404
              ? 'No such incident, or not one you hold.'
              : 'Could not build the report. The record is fine — this screen could not reach it.';
          body.replaceChildren();
          return;
        }
        report = (await res.json()) as Report;
      } catch {
        error.hidden = false;
        error.textContent =
          'No connection. A report is folded from the record on the server, so it needs one.';
        body.replaceChildren();
        return;
      }

      const out = document.createDocumentFragment();

      out.append(letterhead());

      const title = document.createElement('h2');
      title.textContent = `Post-incident report — ${report.what.category}`;
      out.append(title);

      const stamp = document.createElement('p');
      stamp.className = 'meta';
      /**
       * **The district's number, then the uuid** — 2026-08-24, and both are on paper on purpose.
       *
       * This is the page somebody prints and submits. The number is what a DC office writes on
       * a file and quotes back; the uuid is what ties the printed sheet to the log it was folded
       * from a year later, and dropping it would make a filed report untraceable. So the human
       * identity leads and the machine one follows it, at the end of the same grey line.
       *
       * On paper, a document with no generation time is a document nobody can date later.
       */
      stamp.textContent = `Incident ${report.reference ?? 'not yet numbered'} · folded ${when(
        report.generatedAt,
      )} · record id ${report.incidentId}`;
      out.append(stamp);

      out.append(
        section('What happened'),
        pairs([
          ['Kind', report.what.category],
          [
            'Severity',
            report.what.severityAssessed
              ? report.what.severity
              : 'unassessed — nobody assigned a level',
          ],
          ...(report.what.severityOverriddenFrom === null
            ? []
            : ([
                ['Originally assessed', report.what.severityOverriddenFrom],
                ['Reason for the override', report.what.overrideReason ?? 'none recorded'],
              ] as [string, string][])),
        ]),
      );

      out.append(
        section('Who'),
        pairs([
          ['Reported by', actorWords(report.who.reportedBy)],
          [
            'Held by',
            report.who.departments.length > 0
              ? report.who.departments.join(', ')
              : 'no post was assigned',
          ],
          [
            'Acknowledged by',
            report.who.acknowledgedBy === null
              ? 'nobody acknowledged it'
              : actorWords(report.who.acknowledgedBy),
          ],
        ]),
      );

      out.append(
        section('Times'),
        pairs(
          report.timings.map(
            (t) =>
              [
                t.label,
                t.at === null
                  ? (t.missing ?? 'not recorded')
                  : `${when(t.at)}${
                      t.minutesFromOccurrence === null
                        ? ''
                        : ` · ${String(t.minutesFromOccurrence)} min from occurrence`
                    }`,
              ] as [string, string],
          ),
        ),
      );

      if (report.connectivity.lateArrival) {
        const gap = document.createElement('p');
        gap.className = 'note';
        // The district's real coverage picture, not noise (ADR-0002). An hour on a handset
        // with no signal must read as an hour, never as speed.
        gap.textContent =
          `This report spent ${String(report.connectivity.arrivalGapMinutes)} minutes on a ` +
          'device before the server saw it. Every duration above is measured from when it ' +
          'happened, not from when it arrived.';
        out.append(gap);
      }

      if (report.unitsSent.length > 0) {
        out.append(
          section('What was sent'),
          pairs(
            report.unitsSent.map(
              (u) =>
                [
                  u.name,
                  u.minutesCommitted === null
                    ? 'still committed'
                    : `${String(u.minutesCommitted)} min`,
                ] as [string, string],
            ),
          ),
        );
      }

      /**
       * Who is coming — when this notice asked who is coming. In place of a filed page that
       * carried a recipient list and never a count of it; the per-person answers are still in
       * "Who was told" below.
       */
      if (report.attendance != null) {
        const a = report.attendance;
        out.append(section('Who is coming'));
        if (a.told === 0) {
          const none = document.createElement('p');
          none.textContent = 'Nobody was asked.';
          out.append(none);
        } else {
          out.append(
            pairs([
              ['Coming', `${String(a.coming)} of ${String(a.told)}`],
              ['Attending', String(a.attending)],
              ['Sending someone', String(a.sendingSomeone)],
              ['Not attending', String(a.notAttending)],
              ...(a.other > 0
                ? ([['Answered another way', String(a.other)]] as [string, string][])
                : []),
              ['No answer', String(a.unanswered)],
              ...(a.closesAt !== null
                ? ([['Count closed', when(a.closesAt)]] as [string, string][])
                : []),
            ]),
          );
        }
      }

      /**
       * Who was told, whether it landed, and what they said back — the district asked for this
       * by name. One row per person or post; a gap ("not delivered", "no reply") is stated in
       * words, never left blank, for the same reason the gaps section is (ADR-0005).
       */
      out.append(section('Who was told'));
      if (report.recipients.length === 0) {
        const none = document.createElement('p');
        none.textContent = 'Nobody. The control room never chose anybody to tell about this.';
        out.append(none);
      } else {
        const list = document.createElement('ul');
        list.className = 'reportRecipients';
        /**
         * Headed by the group a dispatch expanded — Case 3. `expand()` dissolves the group at
         * send, so these are per-recipient rows; the heading only says which of them were one
         * tick. Drawn only when some recipient carries a group; otherwise the list is flat, with
         * no "Individually notified" over a page that had no group at all.
         */
        const anyGrouped = report.recipients.some((r) => (r.group ?? null) !== null);
        let lastGroup: string | null | undefined;
        for (const r of report.recipients) {
          const group = r.group ?? null;
          if (anyGrouped && group !== lastGroup) {
            const head = document.createElement('li');
            head.className = 'reportRecipientGroup';
            head.textContent = group ?? 'Individually notified';
            list.append(head);
            lastGroup = group;
          }
          const li = document.createElement('li');
          const who = document.createElement('b');
          who.textContent = r.name;
          const delivery = document.createElement('span');
          delivery.className = 'meta';
          delivery.textContent =
            ' — ' +
            (r.delivery === 'delivered'
              ? 'delivered'
              : r.delivery === 'failed'
                ? `not delivered · ${r.failure ?? 'no reason given'}`
                : r.delivery === 'pending'
                  ? 'never confirmed as delivered'
                  : 'no delivery on the record');
          li.append(who, delivery);
          const reply = document.createElement('div');
          reply.textContent =
            r.response === null
              ? 'No reply from this recipient.'
              : `Replied: ${r.response}${r.respondedAt === null ? '' : ` (${when(r.respondedAt)})`}`;
          li.append(reply);
          list.append(li);
        }
        out.append(list);
      }

      out.append(section('What was done'));
      const log = document.createElement('ol');
      log.className = 'reportNarrative';
      for (const entry of report.narrative) {
        const li = document.createElement('li');
        const head = document.createElement('b');
        head.textContent = entry.what;
        const meta = document.createElement('span');
        meta.className = 'meta';
        meta.textContent =
          ` — ${when(entry.at)} · ${actorWords(entry.by)}` +
          (entry.recordedLaterMinutes >= 15
            ? ` · recorded ${String(entry.recordedLaterMinutes)} min later`
            : '') +
          (entry.afterResolution ? ' · after the incident was resolved' : '');
        li.append(head, meta);
        if (entry.detail !== null) {
          const detail = document.createElement('div');
          detail.textContent = entry.detail;
          li.append(detail);
        }
        log.append(li);
      }
      out.append(log);

      out.append(
        section('Outcome'),
        pairs([
          ['Outcome', report.outcome ?? 'none recorded'],
          ['Closing notes', report.closureNotes ?? 'none recorded'],
          ['Escalations', String(report.escalations)],
          [
            'Notifications',
            `${String(report.notifications.delivered)} delivered, ` +
              `${String(report.notifications.failed)} failed, ` +
              `${String(report.notifications.stillPending)} never picked up`,
          ],
          [
            'Evidence',
            report.evidence.length > 0 ? `${String(report.evidence.length)} file(s)` : 'none',
          ],
        ]),
      );

      /**
       * The section a hand-written report always omits, and the one a review most needs.
       *
       * Printed last and printed always — including when it is empty, because "we checked and
       * there were no gaps" and "nobody looked" must not read identically (ADR-0005).
       */
      out.append(section('What this record does not contain'));
      if (report.gaps.length === 0) {
        const none = document.createElement('p');
        none.textContent = 'Nothing missing. Every stage of this incident was recorded.';
        out.append(none);
      } else {
        const gaps = document.createElement('ul');
        gaps.className = 'reportGaps';
        for (const gap of report.gaps) {
          const li = document.createElement('li');
          const what = document.createElement('b');
          what.textContent = gap.what;
          li.append(what, document.createTextNode(` — ${gap.why}`));
          gaps.append(li);
        }
        out.append(gaps);
      }

      body.replaceChildren(out);
    },
  };
}
