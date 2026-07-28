#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
slurm.json 信息脱敏脚本
========================

用途：在集群端"生成 slurm.json -> git push"流程之间调用，
     对用户名做缩写化处理，并清理登录来源等敏感字段。

规则（2026-07-28 与维护者确认）：
  1. 用户名若为汉语拼音全拼姓名（可完整切分为 2-4 个合法拼音音节，
     且名部分至少含 1 个多字母音节），则缩写为"姓全拼 + 名各音节首字母"，
     如 songhongyue -> songhy，zhaobin -> zhaob。
  2. 已是缩写形式（如 zhangyn、zhangxx）或无法完整音节切分的账号
     （如 admin、hpc01）保持原样。
  3. 缩写冲突时追加数字后缀（songhy、songhy2），并通过映射缓存文件保证
     同一原始用户名在历次运行中始终得到同一缩写。
  4. online_users[].from（登录来源）：IPv4 仅保留前两段（如 10.1.x.x），
     其他形式（域名/主机名）整体替换为 "-"。
  5. 删除前端未使用的字段：monthly_corehours、queue_stats、trend。

用法：
  python3 desensitize_slurm.py slurm.json                # 原地覆盖
  python3 desensitize_slurm.py slurm.json -o out.json    # 输出到新文件
  python3 desensitize_slurm.py slurm.json --map map.json # 指定映射缓存
  python3 desensitize_slurm.py slurm.json --dry-run      # 只打印映射，不写文件

集群端建议在推送脚本中插入（示例）：
  python3 scripts/desensitize_slurm.py data/slurm.json --map ~/.slurm_name_map.json
  git add data/slurm.json && git commit -m "update data" && git push

注意：--map 缓存文件务必放在仓库外（如家目录），不可提交到 git，
     否则"原始用户名 -> 缩写"的对应关系被公开，脱敏失效。

依赖：仅 Python 3 标准库（兼容 Python 3.6+，可直接在集群登录节点运行）。
"""

import argparse
import json
import re
import sys
import io
from pathlib import Path

# ---------------------------------------------------------------
# 汉语拼音合法音节表（无声调）
# ---------------------------------------------------------------
_SYLLABLE_TEXT = """
a ai an ang ao
ba bai ban bang bao bei ben beng bi bian biao bie bin bing bo bu
ca cai can cang cao ce cen ceng cha chai chan chang chao che chen cheng chi
chong chou chu chuai chuan chuang chui chun chuo ci cong cou cu cuan cui cun cuo
da dai dan dang dao de dei deng di dia dian diao die ding diu
dong dou du duan dui dun duo
e ei en eng er
fa fan fang fei fen feng fo fou fu
ga gai gan gang gao ge gei gen geng gong gou gu gua guai guan guang gui gun guo
ha hai han hang hao he hei hen heng hong hou hu hua huai huan huang hui hun huo
ji jia jian jiang jiao jie jin jing jiong jiu ju juan jue jun
ka kai kan kang kao ke ken keng kong kou ku kua kuai kuan kuang kui kun kuo
la lai lan lang lao le lei leng li lia lian liang liao lie lin ling liu
long lou lu luan lun luo lv lve
ma mai man mang mao me mei men meng mi mian miao mie min ming miu mo mou mu
na nai nan nang nao ne nei nen neng ni nian niang niao nie nin ning niu
nong nou nu nuan nuo nv nve
o ou
pa pai pan pang pao pei pen peng pi pian piao pie pin ping po pou pu
qi qia qian qiang qiao qie qin qing qiong qiu qu quan que qun
ran rang rao re ren reng ri rong rou ru ruan rui run ruo
sa sai san sang sao se sen seng sha shai shan shang shao she shei shen sheng shi
shou shu shua shuai shuan shuang shui shun shuo si song sou su suan sui sun suo
ta tai tan tang tao te teng ti tian tiao tie ting tong tou tu tuan tui tun tuo
wa wai wan wang wei wen weng wo wu
xi xia xian xiang xiao xie xin xing xiong xiu xu xuan xue xun
ya yan yang yao ye yi yin ying yo yong you yu yuan yue yun
za zai zan zang zao ze zei zen zeng zha zhai zhan zhang zhao zhe zhen zheng zhi
zhong zhou zhu zhua zhuai zhuan zhuang zhui zhun zhuo zi zong zou zu zuan zui zun zuo
"""
SYLLABLES = set(_SYLLABLE_TEXT.split())

# 常见复姓（优先整体匹配为"姓"）
COMPOUND_SURNAMES = {
    "ouyang", "shangguan", "situ", "sima", "zhuge", "xiahou",
    "huangfu", "gongsun", "murong", "dongfang", "linghu", "wanyan",
}

# 常见单姓音节白名单（姓必须落在此表内，降低把普通单词误判为姓名的概率）
COMMON_SURNAMES = {
    "wang", "li", "zhang", "liu", "chen", "yang", "huang", "zhao", "wu", "zhou",
    "xu", "sun", "ma", "zhu", "hu", "guo", "he", "gao", "lin", "luo",
    "zheng", "liang", "xie", "song", "tang", "han", "feng", "deng", "cao", "peng",
    "zeng", "xiao", "tian", "dong", "pan", "yuan", "cai", "jiang", "yu", "du",
    "ye", "cheng", "wei", "su", "lv", "ding", "ren", "shen", "yao", "lu",
    "jia", "fu", "zhong", "fang", "qin", "xia", "tan", "zou", "shi", "xiong",
    "meng", "qi", "hou", "bai", "long", "wan", "duan", "lei", "qian", "yin",
    "yan", "kong", "shao", "mao", "chang", "kang", "gu", "dai", "mo", "gong",
    "fan", "wen", "an", "qiao", "lan", "ni", "min", "zhan", "qu", "jin",
    "huo", "cui", "liao", "xue", "tao", "niu", "qiu", "zhai", "geng", "mu",
    "tong", "guan", "bao", "mei", "hua", "chu", "ruan", "gan", "jing", "rao",
    "shan", "che", "pu", "shu", "ji", "chi", "sheng", "cong", "xiang", "gui",
}


def split_pinyin(word, max_parts=8):
    """把小写字母串切分为合法拼音音节序列；返回所有可能切分（最多前 max 种）。"""
    word = word.lower()
    results = []

    def backtrack(pos, parts):
        if len(results) >= 32:
            return
        if pos == len(word):
            results.append(list(parts))
            return
        if len(parts) >= max_parts:
            return
        # 贪心尝试较长音节优先（拼音音节最长 6 字母，如 zhuang）
        for length in range(min(6, len(word) - pos), 0, -1):
            piece = word[pos:pos + length]
            if piece in SYLLABLES:
                parts.append(piece)
                backtrack(pos + length, parts)
                parts.pop()

    backtrack(0, [])
    return results


def abbreviate_fullname(username):
    """
    判断 username 是否为拼音全拼姓名；是则返回缩写，否则返回 None。

    判定标准：
      - 纯小写字母；
      - 可完整切分为 2-4 个合法音节（复姓场景为 姓1音节 + 名1-2音节 等）；
      - 名部分（姓之后）至少有一个音节长度 >= 2（排除 zhangyn 这类已缩写名）；
      - 姓落在常见姓氏表中。
    """
    if not re.fullmatch(r"[a-z]{4,}", username or ""):
        return None

    candidates = []  # (surname, given_syllables)

    # 复姓优先
    for cs in COMPOUND_SURNAMES:
        if username.startswith(cs) and len(username) > len(cs):
            rest = username[len(cs):]
            for parts in split_pinyin(rest, max_parts=2):
                if 1 <= len(parts) <= 2:
                    candidates.append((cs, parts))

    # 单姓：整体切分后取第一个音节为姓
    for parts in split_pinyin(username, max_parts=4):
        if len(parts) < 2:
            continue  # 单音节不可能是"姓+名"
        surname, given = parts[0], parts[1:]
        if surname not in COMMON_SURNAMES:
            continue
        if len(given) > 2:
            continue  # 名超过两字，多为误切分
        candidates.append((surname, given))

    # 过滤：名部分必须含多字母音节，否则视为已缩写（zhangyn -> 姓 zhang + y,n 不可切分成音节，
    # 本就到不了这里；但 zhangxi 的 xi 是合法音节，属正常全拼）
    valid = [(s, g) for s, g in candidates if any(len(x) >= 2 for x in g)]
    if not valid:
        return None

    # 取名音节数最少的切分（歧义时保守：切分越少越可能是真实姓名结构）
    surname, given = min(valid, key=lambda t: (len(t[1]), -len(t[0])))
    abbr = surname + "".join(x[0] for x in given)
    return abbr if abbr != username else None


def mask_from_field(value):
    """登录来源脱敏：IPv4 保留前两段，其余替换为 '-'。"""
    if not value:
        return value
    m = re.fullmatch(r"(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}", str(value).strip())
    if m:
        return "{}.{}.x.x".format(m.group(1), m.group(2))
    return "-"


def build_mapping(usernames, cache):
    """为所有用户名生成稳定缩写映射；cache 为已有映射 dict（原名->缩写）。"""
    mapping = dict(cache)
    used = set(mapping.values())
    for name in sorted(usernames):
        if not name or name in mapping:
            continue
        abbr = abbreviate_fullname(name)
        if abbr is None:
            mapping[name] = name  # 保持原样
            used.add(name)
            continue
        # 冲突处理：追加数字后缀
        final = abbr
        i = 2
        while final in used and mapping.get(name) != final:
            final = "{}{}".format(abbr, i)
            i += 1
        mapping[name] = final
        used.add(final)
    return mapping


def collect_usernames(data):
    names = set()
    for u in data.get("users", []) or []:
        names.add(u.get("username", ""))
    for j in data.get("jobs", []) or []:
        names.add(j.get("user", ""))
    for n in data.get("nodes", []) or []:
        for x in n.get("users", []) or []:
            names.add(x)
    for o in data.get("online_users", []) or []:
        names.add(o.get("username", ""))
    names.discard("")
    return names


def apply_mapping(data, mapping):
    def m(x):
        return mapping.get(x, x)

    for u in data.get("users", []) or []:
        if "username" in u:
            u["username"] = m(u["username"])
    for j in data.get("jobs", []) or []:
        if "user" in j:
            j["user"] = m(j["user"])
    for n in data.get("nodes", []) or []:
        if isinstance(n.get("users"), list):
            n["users"] = [m(x) for x in n["users"]]
    for o in data.get("online_users", []) or []:
        if "username" in o:
            o["username"] = m(o["username"])
        if "from" in o:
            o["from"] = mask_from_field(o["from"])

    # 告警等自由文本中可能内嵌用户名，做全局替换兜底
    alerts = data.get("alerts", {})
    if isinstance(alerts, dict):
        for a in alerts.get("alerts", []) or []:
            if isinstance(a.get("message"), str):
                for orig, abbr in mapping.items():
                    if orig != abbr and orig in a["message"]:
                        a["message"] = a["message"].replace(orig, abbr)

    # 删除前端未使用字段
    for key in ("monthly_corehours", "queue_stats", "trend"):
        data.pop(key, None)
    return data


def main():
    ap = argparse.ArgumentParser(description="slurm.json 用户名脱敏")
    ap.add_argument("input", help="输入 slurm.json 路径")
    ap.add_argument("-o", "--output", help="输出路径（默认原地覆盖）")
    ap.add_argument("--map", dest="map_file",
                    help="映射缓存文件路径（保证缩写跨运行稳定，务必放在仓库外）")
    ap.add_argument("--dry-run", action="store_true", help="只打印映射结果，不写文件")
    args = ap.parse_args()

    src = Path(args.input)
    data = json.loads(src.read_text(encoding="utf-8"))

    cache = {}
    if args.map_file and Path(args.map_file).exists():
        cache = json.loads(Path(args.map_file).read_text(encoding="utf-8"))

    names = collect_usernames(data)
    mapping = build_mapping(names, cache)

    changed = {k: v for k, v in mapping.items() if k != v}
    kept = sorted(k for k, v in mapping.items() if k == v and k in names)
    out = io.StringIO()
    out.write("== 用户名映射 ==\n")
    for k in sorted(changed):
        out.write("  {:<20} -> {}\n".format(k, changed[k]))
    out.write("== 保持原样 ==\n  {}\n".format(", ".join(kept) if kept else "(无)"))
    sys.stdout.write(out.getvalue())

    if args.dry_run:
        return

    apply_mapping(data, mapping)
    dst = Path(args.output) if args.output else src
    dst.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")),
                   encoding="utf-8")
    sys.stdout.write("已写入: {}\n".format(dst))

    if args.map_file:
        Path(args.map_file).write_text(
            json.dumps(mapping, ensure_ascii=False, indent=2), encoding="utf-8")
        sys.stdout.write("映射缓存已更新: {}\n".format(args.map_file))


if __name__ == "__main__":
    main()
