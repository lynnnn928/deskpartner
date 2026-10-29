/**
 * 版本：一个有实体、能承载"这版做了什么"的对象（1.0.73，主用户 10-07 提）
 *
 * ## 为什么要有它
 *
 * `todos.fixed_in_version` 只回答"这条是哪个版本修的"——
 * 版本**自己没有实体**，于是"这个版本做了什么、为什么发这一版"
 * 只能写在 README 的版本段落里（人读的文档，与看板脱节），
 * 或者散在一堆同版本号的事项里靠人拼。
 *
 * 主用户原话：「版本应该不只是一个字段，它应该是一个对象，
 * 那你就可以在这个对象上面去记录说这个版本里边做了什么、关联了哪些卡片了。]
 *
 * ## 与 todos.fixed_in_version 的关系
 *
 * 靠 `version` 字符串对齐，**不是外键**——理由见迁移 31 的注释：
 * 历史版本的 shipped_at / summary 无从还原，强行回填等于编造；
 * 而"事项标了某版本、releases 里没有那一行"是**元信息缺失**，
 * 不是数据坏了，不该让写入失败。
 *
 * 判据：**没有 release 行时，事项照常标版本，界面显示"未登记"。**
 */
export interface Release {
  /** 版本号，如 "1.0.73"。与 `projectId` 合起来才是身份 —— 两个项目各有自己的 1.0.73 */
  version: string
  /**
   * 这版属于哪个项目（**必填**，v33 起 NOT NULL）
   *
   * 版本是项目下的二级概念（主用户 10-09）：「版本号本来就应该跟产品、项目、模块去关联」。
   * (projectId, version) 是版本的定位键 —— 「知彼的 1.0.76」与「DeskPartner 的 1.0.76」
   * 是两个不同的版本。项目没了版本跟着没（外键 CASCADE，删除项目 = 彻底清空）。
   */
  projectId: string
  /** 发布时刻（ISO）。未发版时为空 —— 不预填"计划发布时间"，那是另一种编造 */
  shippedAt: string | null
  /** 这版在讲什么（一段话，给人和 agent 读的"这版是什么"） */
  summary: string | null
  /**
   * 这版解决了什么，逐条（JSON 字符串数组）
   *
   * 存 JSON 而不是单开一张表：highlights 是**版本的属性**，
   * 它不独立存在、不被别的实体引用、没有自己的生命周期 ——
   * 拆表只会多一层 join 和一套要维护的完整性。
   * 与 `notifications.meta` 同一个取舍。
   */
  highlights: string[]
  createdAt: string
  /**
   * 这版发版前**跑没跑测试**（v32 / 1.0.75，修 `065dcde4`）
   *
   * - `'yes'`     跑了且过了测试闸门（发版链默认路径的产物）
   * - `'no'`      跑了但没过（人工补记）
   * - `'skipped'` 显式 `--skip-tests` 跳过 —— **没过测试闸门**
   * - `null`      历史行 / 未声明：不知道就是不知道，不回填、不编造
   *
   * 为什么三值而不是布尔：「没跑」和「跑了没过」对验收方是两种完全不同的信息，
   * 压成 false 就分不出"这版是跳过测试发的"还是"测试红着发的"。
   */
  tested: 'yes' | 'no' | 'skipped' | null
}

export interface CreateReleaseInput {
  version: string
  /** **必填** —— 版本是项目下的二级概念（主用户 10-09），不挂项目的版本不登记 */
  projectId: string
  shippedAt?: string | null
  summary?: string | null
  highlights?: string[]
  tested?: 'yes' | 'no' | 'skipped' | null
}

export interface UpdateReleaseInput {
  /**
   * **定位键**：要改的是哪个项目的哪一版（不是可改字段）。
   * (项目, 版本号) 是版本的身份 —— 要"挪项目"只能删了重建，不支持改归属。
   */
  projectId: string
  version: string
  /** `null` = 清空；`undefined` = 不动 */
  shippedAt?: string | null
  summary?: string | null
  highlights?: string[]
  /** `null` = 清空（回到"不知道"）；`undefined` = 不动 */
  tested?: 'yes' | 'no' | 'skipped' | null
}

/**
 * 版本对象 + 它收口的事项（读接口的返回形状）
 *
 * ⚠️ `todos` 里的每一条都来自 `fixed_in_version = version`。
 * 它是**派生**的，不另存一份 —— 存了就一定会和事项本身的版本字段对不上。
 */
export interface ReleaseDetail extends Release {
  todos: {
    id: string
    title: string
    status: string
    projectId: string | null
  }[]
  /** 关联事项数（与 `todos.length` 同值，供界面不展开列表时直接显示） */
  todoCount: number
}
