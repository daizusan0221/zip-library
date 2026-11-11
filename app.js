function element(tag, content = "", css = "") {
    const node = document.createElement(tag);
    node.textContent = content;
    node.className = css;
    return node;
}
function required(id) {
    const node = document.getElementById(id);
    if (!node)
        throw new Error("Missing element " + id);
    return node;
}
function object(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Invalid object");
    return value;
}
function string(value) {
    if (typeof value !== "string")
        throw new Error("Invalid text");
    return value;
}
function list(value) {
    if (!Array.isArray(value))
        throw new Error("Invalid list");
    return value;
}
function https(value) {
    const url = new URL(string(value));
    if (url.protocol !== "https:" || url.username || url.password)
        throw new Error("Invalid URL");
    return url.href;
}
function parseCatalog(value) {
    const catalog = object(value);
    const legacy = catalog.schemaVersion === 1;
    const multiStorage = catalog.schemaVersion === 4;
    const externalImages = catalog.schemaVersion === 3 || multiStorage;
    if (!legacy && !externalImages && catalog.schemaVersion !== 2)
        throw new Error("未対応のカタログ形式です。");
    const categories = new Map();
    if (!legacy)
        for (const value of list(catalog.categories)) {
            const item = object(value);
            const id = string(item.id);
            const name = string(item.name);
            const parentId = item.parentId === null ? null : string(item.parentId);
            if (!id.trim() || !name.trim() || categories.has(id))
                throw new Error("Invalid category");
            categories.set(id, { id, name, parentId });
        }
    const works = list(catalog.works).map(item => {
        const work = object(item);
        const image = externalImages
            ? (work.imagePath === null ? null : string(work.imagePath))
            : (work.image == null ? null : string(work.image));
        if (externalImages) {
            if (work.image != null || (image !== null && !/^images\/[a-f0-9]{64}\.(jpg|png|webp)(?![\s\S])/.test(image)))
                throw new Error("Invalid image path");
        }
        else if (image && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(image)) {
            throw new Error("Invalid image");
        }
        let categoryId;
        if (legacy) {
            const name = work.category == null ? "" : string(work.category).trim();
            categoryId = name ? "legacy-" + Array.from(new TextEncoder().encode(name), byte => byte.toString(16).padStart(2, "0")).join("") : null;
            if (categoryId !== null)
                categories.set(categoryId, { id: categoryId, name, parentId: null });
        }
        else {
            categoryId = work.categoryId === null ? null : string(work.categoryId);
            if (categoryId !== null && !categories.has(categoryId))
                throw new Error("Missing category");
        }
        return {
            id: string(work.id), title: string(work.title), categoryId,
            description: string(work.description), image,
            releases: list(work.releases).map(item => {
                const release = object(item);
                if (multiStorage) {
                    const id = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}(?![\s\S])/i;
                    if (!id.test(string(release.releaseId)) || !id.test(string(release.storageId)) ||
                        !string(release.provider).trim() || !string(release.remoteFileId).trim())
                        throw new Error("Invalid storage reference");
                }
                const releasedAt = string(release.releasedAt);
                if (Number.isNaN(Date.parse(releasedAt)))
                    throw new Error("Invalid release date");
                return { version: string(release.version), changelog: string(release.changelog),
                    releasedAt, downloadUrl: https(release.downloadUrl) };
            })
        };
    });
    const children = new Map();
    const ordered = [...categories.values()];
    if (legacy)
        ordered.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const category of ordered) {
        if (category.parentId !== null && !categories.has(category.parentId))
            throw new Error("Missing parent");
        const siblings = children.get(category.parentId) ?? [];
        siblings.push(category);
        children.set(category.parentId, siblings);
    }
    const pending = [...(children.get(null) ?? [])];
    let reachable = 0;
    while (pending.length) {
        const current = pending.pop();
        reachable++;
        for (const child of children.get(current.id) ?? [])
            pending.push(child);
    }
    if (reachable !== categories.size)
        throw new Error("Category cycle");
    return { works, categories, children };
}
const browse = required("browse");
const status = required("status");
const results = required("results");
const search = required("search");
const pageTitle = required("page-title");
const branches = required("branches");
const breadcrumbs = required("breadcrumbs");
const refresh = required("refresh");
let catalog;
function cover(work) {
    const image = element("img", "", "cover");
    image.src = work.image;
    image.alt = "";
    image.loading = "lazy";
    return image;
}
function downloadHref(value) {
    const source = new URL(value);
    if (source.origin !== "https://drive.google.com")
        return value;
    const fileId = /^\/file\/d\/([\w-]+)(?:\/(?:view|preview))?\/?$/.exec(source.pathname)?.[1];
    if (!fileId)
        return value;
    const download = new URL("https://drive.google.com/uc");
    download.searchParams.set("export", "download");
    download.searchParams.set("id", fileId);
    const resourceKey = source.searchParams.get("resourcekey") ?? source.searchParams.get("resourceKey");
    if (resourceKey !== null)
        download.searchParams.set("resourcekey", resourceKey);
    return download.href;
}
function renderDetail(work) {
    const panel = element("article", "", "detail");
    panel.append(element("h1", work.title));
    if (work.image)
        panel.append(cover(work));
    panel.append(element("p", work.description, "multiline"));
    const ordered = [...work.releases].sort((a, b) => Date.parse(b.releasedAt) - Date.parse(a.releasedAt));
    if (!ordered.length) {
        panel.append(element("p", "配布バージョンはありません。"));
        return panel;
    }
    const select = element("select");
    ordered.forEach((release, index) => {
        const option = element("option", release.version);
        option.value = String(index);
        select.append(option);
    });
    const label = element("label", "ダウンロードするバージョン");
    label.append(select);
    const download = element("a", "ZIPをダウンロード", "download");
    download.target = "_blank";
    download.rel = "noopener";
    const date = element("p", "", "meta");
    const changelog = element("p", "", "multiline");
    function showRelease() {
        const release = ordered[Number(select.value)];
        date.textContent = new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium" }).format(new Date(release.releasedAt));
        changelog.textContent = release.changelog || "更新履歴の記載はありません。";
        download.href = downloadHref(release.downloadUrl);
    }
    select.addEventListener("change", showRelease);
    showRelease();
    const history = element("section", "", "release");
    history.append(label, date, download, element("h2", "更新履歴"), changelog);
    panel.append(history);
    return panel;
}
function categoryHref(id) {
    return id === null ? "#" : "#category=" + encodeURIComponent(id);
}
function lineage(id, data) {
    const path = [];
    while (id !== null) {
        const category = data.categories.get(id);
        if (!category)
            break;
        path.push(category);
        id = category.parentId;
    }
    return path.reverse();
}
function renderBreadcrumb(path, current) {
    const list = element("ol");
    const home = element("a", "配布目録");
    home.href = "#";
    const homeItem = element("li");
    homeItem.append(home);
    list.append(homeItem);
    for (const item of path) {
        const link = element("a", item.name);
        link.href = categoryHref(item.id);
        const entry = element("li");
        entry.append(link);
        list.append(entry);
    }
    const entry = element("li", current);
    entry.setAttribute("aria-current", "page");
    list.append(entry);
    breadcrumbs.replaceChildren(list);
}
function render() {
    if (!catalog)
        return;
    const data = catalog;
    status.textContent = "";
    results.replaceChildren();
    const params = new URLSearchParams(location.hash.slice(1));
    const route = params.get("work");
    browse.hidden = route !== null;
    if (route !== null) {
        const work = catalog.works.find(item => item.id === route);
        document.title = work ? work.title + " | ZIP Library" : "ZIP Library";
        renderBreadcrumb(lineage(work?.categoryId ?? null, data), work?.title ?? "作品が見つかりません");
        if (work)
            results.append(renderDetail(work));
        else {
            const back = element("a", "作品一覧へ");
            back.href = "#";
            results.append(element("p", "作品が見つかりません。"), back);
        }
        return;
    }
    const categoryId = params.get("category");
    const current = categoryId === null ? undefined : data.categories.get(categoryId);
    branches.replaceChildren();
    breadcrumbs.replaceChildren();
    pageTitle.textContent = current?.name ?? "配布目録";
    document.title = current ? current.name + " | ZIP Library" : "ZIP Library";
    if (categoryId !== null && !current) {
        renderBreadcrumb([], "カテゴリが見つかりません");
        status.textContent = "カテゴリが見つかりません。";
        return;
    }
    if (current)
        renderBreadcrumb(lineage(current.parentId, data), current.name);
    const children = data.children.get(categoryId) ?? [];
    if (children.length) {
        const list = element("ul", "", "category-list");
        for (const child of children) {
            const item = element("li");
            const link = element("a", "", "category-link");
            link.href = categoryHref(child.id);
            const arrow = element("span", "›");
            arrow.setAttribute("aria-hidden", "true");
            link.append(element("span", child.name), arrow);
            item.append(link);
            list.append(item);
        }
        branches.append(element("h2", current ? "子カテゴリ" : "カテゴリ"), list);
    }
    const terms = search.value.normalize("NFKC").toLocaleLowerCase().trim().split(/\s+/);
    const works = catalog.works.filter(work => {
        if (current && work.categoryId !== current.id)
            return false;
        const path = lineage(work.categoryId, data).map(category => category.name);
        const haystack = [work.title, work.description, ...path].join(" ").normalize("NFKC").toLocaleLowerCase();
        return terms.every(term => haystack.includes(term));
    });
    status.textContent = works.length ? works.length + " 件の作品" :
        search.value.trim() ? "条件に合う作品がありません。" : current ? "このカテゴリに直接所属する作品はありません。" : "公開中の作品はまだありません。";
    if (!works.length)
        return;
    const grid = element("div", "", "work-list");
    for (const work of works) {
        const tile = element("article", "", "work-row");
        const body = element("div", "", "work-body");
        const link = element("a", work.title);
        link.href = "#work=" + encodeURIComponent(work.id);
        const heading = element("h2");
        heading.append(link);
        body.append(heading);
        if (work.categoryId !== null && !current)
            body.append(element("p", lineage(work.categoryId, data).map(category => category.name).join(" / "), "meta"));
        if (work.description)
            body.append(element("p", work.description, "work-summary"));
        if (work.image)
            tile.append(cover(work));
        tile.append(body);
        grid.append(tile);
    }
    results.append(grid);
}
async function load(force = false) {
    refresh.disabled = true;
    status.textContent = "作品情報を読み込んでいます…";
    try {
        const url = new URL("./catalog.json", location.href);
        if (force)
            url.searchParams.set("refresh", Date.now().toString());
        const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(15000) });
        if (!response.ok)
            throw new Error("HTTP " + response.status);
        catalog = parseCatalog(await response.json());
        render();
    }
    catch (error) {
        const schemaError = error instanceof Error && error.message === "未対応のカタログ形式です。";
        status.textContent = schemaError ? "未対応のカタログ形式です。" :
            "作品情報を読み込めませんでした。「更新を確認」で再試行できます。";
    }
    finally {
        refresh.disabled = false;
    }
}
search.addEventListener("input", render);
window.addEventListener("hashchange", () => {
    search.value = "";
    render();
});
refresh.addEventListener("click", () => void load(true));
void load();
export {};
