// BlueWavea — Service du site bluewavea.fr (Edge Function)
// Nom de la fonction : bluewavea-site
//
// Cette fonction ne sert QUE le site public. Elle est indépendante des deux autres
// (« bluewavea-rappels » pour les rappels automatiques, « bluewavea-gmail » pour la
// messagerie des applications) : on peut la redéployer sans rien toucher d'autre.
//
// Trois services, et rien de plus :
//   • site-dispos  : renvoie les plages horaires occupées de l'agenda,
//                    sans aucune donnée de client.
//   • site-rdv     : vérifie le créneau, inscrit le rendez-vous dans l'agenda
//                    (il apparaît aussitôt sur le PC et le mobile), envoie la
//                    confirmation au client et une copie à l'entreprise.
//   • site-contact : envoie le message du formulaire de contact à l'entreprise.
//
// Le site n'écrit jamais directement dans la base : tout est vérifié ici.
//
// ── Réglages (Secrets Supabase — les mêmes que « bluewavea-rappels ») ──
//   BREVO_API_KEY : la clé xkeysib-...
//   SENDER_EMAIL  : bluewavea.bw@gmail.com
//   SENDER_NAME   : BlueWavea
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY : injectés automatiquement par Supabase

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const BREVO_API_KEY = Deno.env.get("BREVO_API_KEY")!;
const SENDER_EMAIL = Deno.env.get("SENDER_EMAIL") || "bluewavea.bw@gmail.com";
const SENDER_NAME = Deno.env.get("SENDER_NAME") || "BlueWavea";
const TEL = "06 50 37 89 30";
const SIGN = "\n\nBien cordialement,\nBlueWavea\n" + TEL + "\n" + SENDER_EMAIL;

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...CORS, "content-type": "application/json" } });

async function envoyerMail(to: string, toName: string, sujet: string, texte: string) {
  const rep = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": BREVO_API_KEY, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      sender: { email: SENDER_EMAIL, name: SENDER_NAME },
      to: [{ email: to, name: toName || to }],
      subject: sujet,
      textContent: texte,
    }),
  });
  if (!rep.ok) throw new Error("envoi refusé (" + rep.status + ")");
}

// ── Règles de l'agenda, identiques aux applications ──
const TRAJET = 30;                       // minutes réservées avant et après chaque rendez-vous
const OUVERTURE = 8 * 60, FERMETURE = 18 * 60;
const PAUSE_DEB = 12 * 60, PAUSE_FIN = 13 * 60;
const DUREES: Record<string, number> = { entretien: 60, repar: 90, mes: 90 };
const LIBELLES: Record<string, string> = { entretien: "Entretien", repar: "Dépannage", mes: "Mise en service" };

/* Occupation réelle de l'agenda : uniquement des plages horaires.
   Un créneau ne se libère que si le rendez-vous est annulé ou retiré de l'agenda. */
async function occupation(env: string) {
  const r = await supabase.from("rdvs").select("data");
  const occup: Record<string, number[][]> = {};
  for (const row of (r.data || []) as any[]) {
    const d = row && row.data;
    if (!d || d._deleted || !d.date || !d.heure) continue;
    if ((d._env || "test") !== env) continue;
    if (d.statut === "Annulé") continue;
    const p = String(d.heure).split(":");
    const deb = (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0);
    const duree = DUREES[d.kind] || 60;
    (occup[d.date] = occup[d.date] || []).push([deb - TRAJET, deb + duree + TRAJET]);
  }
  return occup;
}

function creneauLibre(occ: number[][], deb: number, min: number) {
  const fin = deb + min;
  if (deb < OUVERTURE || fin > FERMETURE) return false;
  if (deb < PAUSE_FIN && fin > PAUSE_DEB) return false;
  const a = deb - TRAJET, b = fin + TRAJET;
  return !(occ || []).some(([x, y]) => a < y && b > x);
}

const propre = (v: unknown) => String(v == null ? "" : v).replace(/[\r\n]+/g, " ").trim().slice(0, 300);
const capital = (v: string) => (v ? v.charAt(0).toUpperCase() + v.slice(1) : "");
const dateFr = (iso: string) => iso.split("-").reverse().join("/");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, erreur: "méthode non autorisée" }, 405);

  let corps: any = null;
  try { corps = await req.json(); } catch (_e) { corps = null; }
  const action = String((corps && corps.action) || "");
  const env = (corps && corps.env) === "test" ? "test" : "prod";

  try {
    // ── 1) Disponibilités de l'agenda ──
    if (action === "site-dispos") {
      return json({ ok: true, occup: await occupation(env) });
    }

    // ── 2) Prise de rendez-vous ──
    if (action === "site-rdv") {
      const kind = String((corps && corps.kind) || "");
      if (!DUREES[kind]) return json({ ok: false, erreur: "prestation inconnue" }, 400);

      const f = {
        date: propre(corps.date), heure: propre(corps.heure),
        civilite: propre(corps.civilite) === "Madame" ? "Madame" : "Monsieur",
        nom: propre(corps.nom), prenom: propre(corps.prenom),
        tel: propre(corps.tel), email: propre(corps.email),
        adresse: propre(corps.adresse), cp: propre(corps.cp), ville: propre(corps.ville),
        message: propre(corps.message),
      };
      // tous les champs sont obligatoires, comme sur le site
      for (const [k, v] of Object.entries(f)) if (!v) return json({ ok: false, erreur: "champ manquant : " + k }, 400);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(f.date) || !/^\d{2}:\d{2}$/.test(f.heure)) return json({ ok: false, erreur: "date ou heure invalide" }, 400);
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email)) return json({ ok: false, erreur: "adresse e-mail invalide" }, 400);

      const jour = new Date(f.date + "T00:00:00");
      const demain = new Date(); demain.setHours(0, 0, 0, 0); demain.setDate(demain.getDate() + 1);
      if (isNaN(jour.getTime()) || jour < demain || jour.getDay() === 0) return json({ ok: false, erreur: "jour indisponible" }, 409);

      const deb = parseInt(f.heure.slice(0, 2), 10) * 60 + parseInt(f.heure.slice(3, 5), 10);
      const occup = await occupation(env);
      if (!creneauLibre(occup[f.date] || [], deb, DUREES[kind])) return json({ ok: false, erreur: "créneau déjà pris" }, 409);

      const nomComplet = f.nom.toUpperCase() + " " + capital(f.prenom);
      const id = "web" + Date.now();
      const entry = {
        id, date: f.date, heure: f.heure,
        client: nomComplet, type: LIBELLES[kind], kind, clientId: null, contratType: "",
        statut: "À venir",
        commentaire: "Rendez-vous pris sur bluewavea.fr\n"
          + f.civilite + " " + nomComplet + "\n"
          + "Téléphone : " + f.tel + "\nE-mail : " + f.email + "\n"
          + "Adresse : " + f.adresse + "\n" + f.cp + " " + f.ville
          + "\nPrécisions : " + f.message,
        pieces: [], origine: "site", _env: env,
      };
      const ins = await supabase.from("rdvs").upsert([{ id, data: entry }]);
      if (ins.error) return json({ ok: false, erreur: "enregistrement impossible" }, 500);

      let mail = true;
      try {
        // confirmation au client
        await envoyerMail(f.email, nomComplet,
          "Confirmation de votre rendez-vous BlueWavea — " + dateFr(f.date) + " à " + f.heure,
          "Bonjour " + f.civilite + " " + f.nom.toUpperCase() + ",\n\n"
          + "Votre rendez-vous est enregistré.\n\n"
          + "Prestation : " + LIBELLES[kind] + "\n"
          + "Date : " + dateFr(f.date) + " à " + f.heure + "\n"
          + "Adresse : " + f.adresse + ", " + f.cp + " " + f.ville + "\n\n"
          + "En cas d'empêchement, prévenez-moi au " + TEL + "." + SIGN);
        // copie pour l'entreprise
        await envoyerMail(SENDER_EMAIL, SENDER_NAME,
          "Nouveau RDV en ligne — " + dateFr(f.date) + " à " + f.heure + " — " + nomComplet,
          "Prestation : " + LIBELLES[kind] + "\n\n" + entry.commentaire);
      } catch (_e) { mail = false; }

      return json({ ok: true, id, mail });
    }

    // ── 3) Formulaire de contact ──
    if (action === "site-contact") {
      const f = {
        civilite: propre(corps.civilite) === "Madame" ? "Madame" : "Monsieur",
        nom: propre(corps.nom), prenom: propre(corps.prenom),
        tel: propre(corps.tel), email: propre(corps.email),
        adresse: propre(corps.adresse), cp: propre(corps.cp), ville: propre(corps.ville),
        sujet: propre(corps.sujet), message: String((corps && corps.message) || "").trim().slice(0, 4000),
      };
      for (const [k, v] of Object.entries(f)) if (!v) return json({ ok: false, erreur: "champ manquant : " + k }, 400);
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email)) return json({ ok: false, erreur: "adresse e-mail invalide" }, 400);

      const nomComplet = f.nom.toUpperCase() + " " + capital(f.prenom);
      await envoyerMail(SENDER_EMAIL, SENDER_NAME, f.sujet + " — " + nomComplet,
        "Message déposé sur bluewavea.fr\n\n"
        + f.civilite + " " + nomComplet + "\n"
        + "Téléphone : " + f.tel + "\nE-mail : " + f.email + "\n"
        + "Adresse : " + f.adresse + "\n" + f.cp + " " + f.ville + "\n"
        + "Sujet : " + f.sujet + "\n\n" + f.message + "\n");
      return json({ ok: true });
    }

    return json({ ok: false, erreur: "action inconnue" }, 400);
  } catch (e) {
    return json({ ok: false, erreur: String(e) }, 500);
  }
});
