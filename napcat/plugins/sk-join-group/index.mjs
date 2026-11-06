// 一次性插件：主动申请加入 TARGET_GROUP 指定的群。
// 复刻社区已验证路径：searchGroup 拿 groupOption/joinGroupAuth → GroupService.reqToJoinGroup。
// 结果落 result.json（卷内），且打 NapCat 日志；已完成（结果存在）则直接跳过。
import fs from "node:fs";
import path from "node:path";

const GROUP = Number(process.env.TARGET_GROUP || 0);

export async function plugin_init(ctx) {
  const resultFile = path.join(ctx.pluginPath, "result.json");
  ctx.logger.info("sk-join-group loaded");
  if (!GROUP) { ctx.logger.info("sk-join-group: TARGET_GROUP not set, idle"); return; }
  try {
    if (fs.existsSync(resultFile)) {
      ctx.logger.info("sk-join-group: already has result, skip");
      return;
    }
    const session = ctx.core?.context?.session;
    const groupApi = ctx.core?.apis?.GroupApi;
    if (!session || !groupApi) throw new Error("core session/apis unavailable");

    // ① 搜索目标群，拿加群设置与 auth
    const searched = await Promise.resolve(groupApi.searchGroup(String(GROUP)));
    const info = [searched?.searchGroupInfo, searched?.data?.searchGroupInfo, searched?.data, searched]
      .find((x) => x && typeof x === "object" && (x.groupCode != null || x.group_id != null)
        && String(x.groupCode ?? x.group_id) === String(GROUP)) || null;
    const groupOption = Number(info?.groupOption ?? 0);
    const question = String(info?.groupQuestion ?? "").trim();
    const auth = String(info?.joinGroupAuth ?? "");
    ctx.logger.info(`sk-join-group: search ok option=${groupOption} question="${question}" authLen=${auth.length}`);

    // ② 需要答验证问题的群（4=答问题由管理员审核, 5=答问题自动过）没有答案不发
    if (groupOption === 4 || groupOption === 5) {
      const out = { status: "answer_required", groupOption, question, ts: new Date().toISOString() };
      fs.writeFileSync(resultFile, JSON.stringify(out, null, 2));
      ctx.logger.info(`sk-join-group: ANSWER REQUIRED: ${question}`);
      return;
    }
    if (groupOption === 3) {
      const out = { status: "group_join_disabled", groupOption, ts: new Date().toISOString() };
      fs.writeFileSync(resultFile, JSON.stringify(out, null, 2));
      ctx.logger.info("sk-join-group: join disabled by group settings");
      return;
    }

    // ③ 提交加群申请（两种 arity 兼容）
    const gs = session.getGroupService();
    const req = {
      groupCode: Number(GROUP),
      sourceId: 3,
      sourceSubId: 0,
      applyMsg: "",
      auth,
      token: "",
      noVerifyAuth: ""
    };
    let result;
    const arity = gs.reqToJoinGroup?.length ?? -1;
    if (typeof gs.reqToJoinGroup !== "function") throw new Error("reqToJoinGroup missing on GroupService");
    result = arity >= 2
      ? await gs.reqToJoinGroup(String(GROUP), req)
      : await gs.reqToJoinGroup(req);
    ctx.logger.info(`sk-join-group: submitted, native result=${JSON.stringify(result)?.slice(0, 300)}`);

    const out = {
      status: "submitted", groupOption, question,
      nativeResult: result ?? null, arity,
      ts: new Date().toISOString()
    };
    fs.writeFileSync(resultFile, JSON.stringify(out, null, 2));
  } catch (e) {
    const out = { status: "error", error: String(e?.message || e), stack: String(e?.stack || "").slice(0, 400), ts: new Date().toISOString() };
    try { fs.writeFileSync(resultFile, JSON.stringify(out, null, 2)); } catch {}
    ctx.logger.logError("sk-join-group failed:", e);
  }
}

export async function plugin_cleanup() {}
