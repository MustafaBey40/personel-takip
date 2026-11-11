import { getStore } from "@netlify/blobs";

export const config = { path: "/api/*" };

const json = (d, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });

function dist(a, b, c, d) {
  const R = 6371000, r = Math.PI / 180;
  const x = Math.sin(((c - a) * r) / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(((d - b) * r) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

export default async (req) => {
  const route = new URL(req.url).pathname.replace(/^\/api\/?/, "");
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  const store = getStore({ name: "pdks", consistency: "strong" });
  const emps = (await store.get("employees", { type: "json" })) || [];
  const settings = (await store.get("settings", { type: "json" })) || null;
  const adminPin = process.env.ADMIN_PIN;
  const isAdmin = !!adminPin && String(body.adminPin) === String(adminPin);
  const findEmp = () => emps.find((e) => e.id === body.empId && e.pin === String(body.pin));
  const getLog = async (id) => (await store.get("log:" + id, { type: "json" })) || [];

  // Herkese açık: giriş ekranındaki isim listesi
  if (route === "employees") return json(emps.map((e) => ({ id: e.id, name: e.name })));

  // Çalışan: giriş / çıkış (saat sunucudan alınır, telefon saati kullanılmaz)
  if (route === "clock") {
    const e = findEmp();
    if (!e) return json({ error: "Şifre hatalı" }, 401);
    if (settings && settings.lat != null) {
      const lat = Number(body.lat), lng = Number(body.lng);
      if (!isFinite(lat) || !isFinite(lng))
        return json({ error: "Konum alınamadı. Tarayıcıda konum iznini verin ve konumu açın." }, 403);
      const d = dist(settings.lat, settings.lng, lat, lng);
      const tol = Math.min(Number(body.acc) || 0, 100);
      if (d > settings.radius + tol)
        return json({ error: `Lokantadan yaklaşık ${Math.round(d)} m uzaktasınız. Giriş/çıkış sadece lokantada yapılabilir.` }, 403);
    }
    // Cihaz kontrolü: telefon ilk kullanan çalışana eşleşir, başkası kullanırsa işaretlenir
    let flag = null;
    const did = String(body.did || "");
    if (did.length >= 8 && did.length <= 64) {
      const devices = (await store.get("devices", { type: "json" })) || {};
      if (!devices[did]) {
        devices[did] = e.id;
        await store.setJSON("devices", devices);
      } else if (devices[did] !== e.id) flag = devices[did];
    }
    const log = await getLog(e.id);
    const last = log.length ? log[log.length - 1] : null;
    const t = last && last.t === "in" ? "out" : "in";
    const ev = { t, ts: new Date().toISOString() };
    if (flag) ev.flag = flag;
    log.push(ev);
    await store.setJSON("log:" + e.id, log);
    return json({ ok: true, type: t, flagged: !!flag });
  }

  // Çalışan: kendi kayıtları
  if (route === "me") {
    const e = findEmp();
    if (!e) return json({ error: "Şifre hatalı" }, 401);
    return json({ name: e.name, events: await getLog(e.id) });
  }

  // Yönetici işlemleri
  if (route.startsWith("admin/")) {
    if (!isAdmin) return json({ error: "Yönetici şifresi hatalı" }, 401);

    if (route === "admin/report") {
      const logs = {};
      for (const e of emps) logs[e.id] = await getLog(e.id);
      return json({ employees: emps, logs, settings });
    }
    if (route === "admin/add") {
      const name = String(body.name || "").trim();
      const pin = String(body.pin || "").trim();
      if (!name || pin.length < 4) return json({ error: "İsim ve en az 4 haneli şifre gerekli" }, 400);
      emps.push({ id: crypto.randomUUID().slice(0, 8), name, pin });
      await store.setJSON("employees", emps);
      return json({ ok: true });
    }
    if (route === "admin/setloc") {
      if (body.clear) await store.delete("settings");
      else {
        const lat = Number(body.lat), lng = Number(body.lng), radius = Math.max(30, Number(body.radius) || 150);
        if (!isFinite(lat) || !isFinite(lng)) return json({ error: "Konum alınamadı" }, 400);
        await store.setJSON("settings", { lat, lng, radius });
      }
      return json({ ok: true });
    }
    if (route === "admin/resetdev") {
      await store.delete("devices");
      return json({ ok: true });
    }
    if (route === "admin/remove") {
      await store.setJSON("employees", emps.filter((e) => e.id !== body.empId));
      return json({ ok: true });
    }
    // Unutulan giriş/çıkışı elle ekle veya sil
    if (route === "admin/event") {
      const log = await getLog(body.empId);
      if (body.action === "add") log.push({ t: body.t, ts: new Date(body.ts).toISOString(), manual: true });
      if (body.action === "del") log.splice(0, log.length, ...log.filter((x) => x.ts !== body.ts));
      log.sort((a, b) => (a.ts < b.ts ? -1 : 1));
      await store.setJSON("log:" + body.empId, log);
      return json({ ok: true });
    }
  }
  return json({ error: "Bulunamadı" }, 404);
};
