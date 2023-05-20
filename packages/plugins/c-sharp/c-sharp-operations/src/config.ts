import { RawClientSideBasePluginConfig } from '@graphql-codegen/visitor-plugin-common';

/**
 * @description This plugin generates C# `class` based on your GraphQL operations.
 */
export interface CSharpOperationsRawPluginConfig extends RawClientSideBasePluginConfig {
  /**
   * @default GraphQLCodeGen
   * @description Allow you to customize the namespace name.
   *
   * @exampleMarkdown
   * ```yaml
   * config:
   *   namespaceName: MyCompany.MyNamespace
   * ```
   */
  namespaceName?: string;
  /**
   * @default GraphQLClient
   * @description Allow you to customize the operations class name.
   *
   * @exampleMarkdown
   * ```yaml
   * config:
   *   operationsClassName: MyCompanyGQLOperations
   * ```
   */
  operationsClassName?: string;
  /**
   * @description Defined the global value of `namedClient`.
   *
   * @exampleMarkdown
   * ```yaml
   * config:
   *   namedClient: 'customName'
   * ```
   */
  namedClient?: string;
  /**
   * @description Allows to define a custom suffix for query operations.
   * @default GQL
   *
   * @exampleMarkdown
   * ```yaml
   * config:
   *   querySuffix: 'QueryService'
   * ```
   */
  querySuffix?: string;
  /**
   * @description Allows to define a custom suffix for mutation operations.
   * @default GQL
   *
   * @exampleMarkdown
   * ```yaml
   * config:
   *   mutationSuffix: 'MutationService'
   * ```
   */
  mutationSuffix?: string;
  /**
   * @description Allows to define a custom suffix for Subscription operations.
   * @default GQL
   *
   * @exampleMarkdown
   * ```yaml
   * config:
   *   subscriptionSuffix: 'SubscriptionService'
   * ```
   */
  subscriptionSuffix?: string;
  /**
   * @description Allows to generate operation methods with class definitions for request/response parameters
   * @default false
   *
   * @exampleMarkdown
   * ```yaml
   * config:
   *   typesafeOperation: true
   * ```
   */
  typesafeOperation?: boolean;
  /**
   * @description Defines the HTTP GraphQL client endpoint to use
   * @default []
   *
   * @exampleMarkdown
   * ```yaml
   * config:
   *   httpClientConfig: {
         prod: 'https://my-prod-endpoint.com/graphql',
         dev: 'https://my-dev-endpoint.com/graphql',
         useDevIf: 'UnityEngine.Debug.isDebugBuild'
       }
   * ```
   */
  httpClientConfig?: {
    prodEndpoint: string;
    devEndpoint: string;
    useDevIf: string;
  };
}
